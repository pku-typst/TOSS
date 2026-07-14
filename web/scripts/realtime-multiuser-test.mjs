import * as Y from "yjs";
import { projectContentEpochHeader } from "./lib/project-content-epoch.mjs";

const CORE_API = process.env.CORE_API_URL ?? "http://127.0.0.1:18080";
const REALTIME_WS = process.env.REALTIME_WS_URL ?? "ws://127.0.0.1:18080";
const runId = Date.now().toString();
const ownerEmail = `rt-owner-${runId}@example.com`;
const ownerPassword = "Owner1234!";
const collabEmail = `rt-collab-${runId}@example.com`;
const collabPassword = "Collab1234!";
const DOC_PATH = "main.typ";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toBase64(update) {
  return Buffer.from(update).toString("base64");
}

function fromBase64(value) {
  return new Uint8Array(Buffer.from(value, "base64"));
}

async function parseJson(res) {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

async function authJson(method, route, body) {
  const response = await fetch(`${CORE_API}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await parseJson(response);
  if (!response.ok) {
    throw new Error(`${method} ${route} failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function api(method, path, sessionToken, body) {
  const contentEpochHeader = await projectContentEpochHeader(CORE_API, method, path, sessionToken);
  const response = await fetch(`${CORE_API}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
      ...contentEpochHeader
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await parseJson(response);
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function registerOrLogin(email, password, displayName) {
  const emailPrefix = email.split("@")[0] || "user";
  const username = emailPrefix.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 32) || `user${Date.now()}`;
  const registerRes = await fetch(`${CORE_API}/v1/auth/local/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      username,
      display_name: displayName
    })
  });
  if (registerRes.ok) {
    const payload = await parseJson(registerRes);
    return { userId: payload.user_id, sessionToken: payload.session_token, email, password };
  }
  if (registerRes.status !== 403 && registerRes.status !== 409) {
    const payload = await parseJson(registerRes);
    throw new Error(`register ${email} failed: ${registerRes.status} ${JSON.stringify(payload)}`);
  }
  const login = await authJson("POST", "/v1/auth/local/login", { email, password });
  return { userId: login.user_id, sessionToken: login.session_token, email, password };
}

function connectClient(
  projectId,
  documentId,
  collaborationRevision,
  userId,
  userName,
  sessionToken
) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("main");
  const query = new URLSearchParams({
    project_id: projectId,
    collaboration_revision: String(collaborationRevision),
    user_id: userId,
    user_name: userName,
    session_token: sessionToken
  });
  const wsUrl = `${REALTIME_WS}/v1/realtime/ws/${encodeURIComponent(documentId)}?${query.toString()}`;
  const ws = new WebSocket(wsUrl);
  const origin = `test-${userId}`;
  const presence = new Set([userId]);
  let requestSequence = 0;
  const nextRequestId = () => `${origin}:${++requestSequence}`;

  ws.addEventListener("open", () => {
    const snapshot = Y.encodeStateAsUpdate(ydoc);
    ws.send(
      JSON.stringify({
        kind: "yjs.sync",
        origin,
        request_id: nextRequestId(),
        payload: toBase64(snapshot)
      })
    );
  });

  ydoc.on("update", (update, updateOrigin) => {
    if (updateOrigin === "remote") return;
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        kind: "yjs.update",
        origin,
        request_id: nextRequestId(),
        payload: toBase64(update)
      })
    );
  });

  ws.addEventListener("message", (event) => {
    const parsed = JSON.parse(String(event.data));
    const kind = parsed?.kind;
    const payload = parsed?.payload;
    const eventUser = parsed?.user_id;
    if (kind === "presence.join" && typeof eventUser === "string") presence.add(eventUser);
    if (kind === "presence.join" && typeof eventUser === "string" && eventUser !== userId) {
      if (ws.readyState === WebSocket.OPEN) {
        const snapshot = Y.encodeStateAsUpdate(ydoc);
        ws.send(
          JSON.stringify({
            kind: "yjs.sync",
            origin,
            request_id: nextRequestId(),
            payload: toBase64(snapshot)
          })
        );
      }
    }
    if (kind === "presence.leave" && typeof eventUser === "string") presence.delete(eventUser);
    if (kind === "doc.update" || kind === "yjs.update" || kind === "yjs.sync") {
      const maybePayload = typeof payload === "string" ? payload : payload?.payload;
      if (typeof maybePayload === "string") {
        Y.applyUpdate(ydoc, fromBase64(maybePayload), "remote");
      }
    }
  });

  return {
    userId,
    ydoc,
    ytext,
    ws,
    presence,
    close() {
      ws.close();
      ydoc.destroy();
    }
  };
}

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await wait(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  const owner = await registerOrLogin(ownerEmail, ownerPassword, "Realtime Owner");
  const collaborator = await registerOrLogin(collabEmail, collabPassword, "Realtime Collaborator");
  const project = await api("POST", "/v1/projects", owner.sessionToken, {
    name: `Realtime QA ${runId}`
  });
  const projectId = project.id;
  await api("POST", `/v1/projects/${projectId}/roles`, owner.sessionToken, {
    user_id: collaborator.userId,
    role: "ReadWrite"
  });
  const document = await api(
    "PUT",
    `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent(DOC_PATH)}`,
    owner.sessionToken,
    { content: "= Realtime QA\n\nSeed.\n" }
  );

  const clients = [];
  try {
    const a = connectClient(
      projectId,
      document.id,
      document.collaboration_revision,
      owner.userId,
      "Realtime Owner",
      owner.sessionToken
    );
    const b = connectClient(
      projectId,
      document.id,
      document.collaboration_revision,
      collaborator.userId,
      "Realtime Collaborator",
      collaborator.sessionToken
    );
    clients.push(a, b);

    await waitFor(
      () => a.ws.readyState === WebSocket.OPEN && b.ws.readyState === WebSocket.OPEN,
      5000,
      "socket open"
    );
    await wait(400);

    a.ydoc.transact(() => {
      a.ytext.delete(0, a.ytext.length);
      a.ytext.insert(0, "= Realtime QA\n\nEdited by A.\n");
    }, "A1");
    await waitFor(() => b.ytext.toString().includes("Edited by A."), 5000, "A update visible on B");

    b.ydoc.transact(() => {
      b.ytext.insert(b.ytext.length, "Edited by B.\n");
    }, "B1");
    await waitFor(() => a.ytext.toString().includes("Edited by B."), 5000, "B update visible on A");

    const merged = a.ytext.toString();
    if (merged !== b.ytext.toString()) {
      throw new Error("divergence after concurrent edits");
    }

    b.ws.close();
    await wait(300);
    const b2 = connectClient(
      projectId,
      document.id,
      document.collaboration_revision,
      collaborator.userId,
      "Realtime Collaborator",
      collaborator.sessionToken
    );
    clients.push(b2);
    await waitFor(() => b2.ws.readyState === WebSocket.OPEN, 5000, "B reconnect open");
    await waitFor(
      () => b2.ytext.toString().includes("Edited by A.") && b2.ytext.toString().includes("Edited by B."),
      5000,
      "B reconnect state sync"
    );

    const result = {
      ok: true,
      project_id: projectId,
      userA_presence: Array.from(a.presence),
      userB_presence: Array.from(b2.presence),
      final_text: b2.ytext.toString()
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    for (const client of clients) client.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error) }, null, 2));
  process.exitCode = 1;
});
