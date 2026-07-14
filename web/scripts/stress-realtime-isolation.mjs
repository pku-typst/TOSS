import * as Y from "yjs";

const CORE_API = process.env.CORE_API_URL ?? "http://127.0.0.1:18080";
const REALTIME_WS = process.env.REALTIME_WS_URL ?? "ws://127.0.0.1:18080";
const runId = Date.now().toString();

const ownerAEmail = `iso-a-${runId}@example.com`;
const ownerBEmail = `iso-b-${runId}@example.com`;
const password = "Owner1234!";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function parseJson(res) {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

async function api(method, route, token, body) {
  const res = await fetch(`${CORE_API}${route}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await parseJson(res);
  if (!res.ok) throw new Error(`${method} ${route} failed: ${res.status} ${JSON.stringify(payload)}`);
  return payload;
}

async function register(email, displayName) {
  const emailPrefix = email.split("@")[0] || "user";
  const username = emailPrefix.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 32) || `user${Date.now()}`;
  const res = await fetch(`${CORE_API}/v1/auth/local/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      username,
      display_name: displayName
    })
  });
  const payload = await parseJson(res);
  if (!res.ok) throw new Error(`register failed: ${res.status} ${JSON.stringify(payload)}`);
  return payload;
}

function openSocket({ documentId, collaborationRevision, projectId, userId, sessionToken }) {
  const query = new URLSearchParams({
    project_id: projectId,
    collaboration_revision: String(collaborationRevision),
    user_id: userId,
    session_token: sessionToken
  });
  const url = `${REALTIME_WS}/v1/realtime/ws/${encodeURIComponent(documentId)}?${query.toString()}`;
  const ws = new WebSocket(url);
  const received = [];
  ws.addEventListener("message", (event) => {
    try {
      received.push(JSON.parse(String(event.data)));
    } catch {
      // ignore parse failures
    }
  });
  return { ws, received };
}

function encodedUpdate(token) {
  const doc = new Y.Doc();
  doc.getText("main").insert(0, token);
  const update = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
  doc.destroy();
  return update;
}

function eventUpdate(event) {
  const payload = event?.payload;
  return typeof payload === "string" ? payload : payload?.payload;
}

async function waitForOpen(ws, label) {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    if (ws.readyState === WebSocket.OPEN) return;
    await wait(60);
  }
  throw new Error(`timeout waiting socket open: ${label}`);
}

async function main() {
  const authA = await register(ownerAEmail, "Isolation A");
  const authB = await register(ownerBEmail, "Isolation B");
  const projectA = await api("POST", "/v1/projects", authA.session_token, { name: `Isolation A ${runId}` });
  const projectB = await api("POST", "/v1/projects", authB.session_token, { name: `Isolation B ${runId}` });
  const documentsA = await api("GET", `/v1/projects/${projectA.id}/documents`, authA.session_token);
  const documentsB = await api("GET", `/v1/projects/${projectB.id}/documents`, authB.session_token);
  const documentA = documentsA.documents.find((document) => document.path === "main.typ");
  const documentB = documentsB.documents.find((document) => document.path === "main.typ");
  if (!documentA || !documentB) {
    throw new Error("new Typst project is missing main.typ");
  }

  const a = openSocket({
    documentId: documentA.id,
    collaborationRevision: documentA.collaboration_revision,
    projectId: projectA.id,
    userId: authA.user_id,
    sessionToken: authA.session_token
  });
  const b = openSocket({
    documentId: documentB.id,
    collaborationRevision: documentB.collaboration_revision,
    projectId: projectB.id,
    userId: authB.user_id,
    sessionToken: authB.session_token
  });

  await waitForOpen(a.ws, "A");
  await waitForOpen(b.ws, "B");
  await wait(150);

  const tokenA = `A-${runId}`;
  const tokenB = `B-${runId}`;
  const updateA = encodedUpdate(tokenA);
  const updateB = encodedUpdate(tokenB);
  a.ws.send(
    JSON.stringify({
      kind: "yjs.update",
      origin: "isolation-a",
      request_id: `isolation-a:${runId}`,
      payload: updateA
    })
  );
  b.ws.send(
    JSON.stringify({
      kind: "yjs.update",
      origin: "isolation-b",
      request_id: `isolation-b:${runId}`,
      payload: updateB
    })
  );
  await wait(600);

  const leakedToA = a.received.some((event) => eventUpdate(event) === updateB);
  const leakedToB = b.received.some((event) => eventUpdate(event) === updateA);

  a.ws.close();
  b.ws.close();

  if (leakedToA || leakedToB) {
    throw new Error(`cross-project realtime leak detected (toA=${leakedToA}, toB=${leakedToB})`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        projectA: projectA.id,
        projectB: projectB.id,
        documentA: documentA.id,
        documentB: documentB.id
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: String(error)
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
