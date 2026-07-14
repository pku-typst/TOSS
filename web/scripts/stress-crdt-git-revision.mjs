import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import * as Y from "yjs";
import { projectContentEpochHeader } from "./lib/project-content-epoch.mjs";

const CORE_API = process.env.CORE_API_URL ?? "http://127.0.0.1:18080";
const REALTIME_WS = process.env.REALTIME_WS_URL ?? "ws://127.0.0.1:18080";
const ROUNDS = Number.parseInt(process.env.STRESS_ROUNDS ?? "60", 10);
const runId = Date.now().toString();
const ownerEmail = `stress-owner-${runId}@example.com`;
const ownerPassword = "Owner1234!";
const collabEmail = `stress-collab-${runId}@example.com`;
const collabPassword = "Collab1234!";
const DOC_PATH = "main.typ";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: "pipe" }).toString("utf8").trim();
}

async function parseJson(res) {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

async function api(method, route, token, body) {
  const contentEpochHeader = await projectContentEpochHeader(CORE_API, method, route, token);
  const res = await fetch(`${CORE_API}${route}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...contentEpochHeader
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await parseJson(res);
  if (!res.ok) {
    throw new Error(`${method} ${route} failed: ${res.status} ${JSON.stringify(payload)}`);
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
    return {
      userId: payload.user_id,
      sessionToken: payload.session_token,
      email,
      password
    };
  }
  if (registerRes.status !== 403 && registerRes.status !== 409) {
    const payload = await parseJson(registerRes);
    throw new Error(`register failed: ${registerRes.status} ${JSON.stringify(payload)}`);
  }
  const loginRes = await fetch(`${CORE_API}/v1/auth/local/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const login = await parseJson(loginRes);
  if (!loginRes.ok) {
    throw new Error(`login failed: ${loginRes.status} ${JSON.stringify(login)}`);
  }
  return {
    userId: login.user_id,
    sessionToken: login.session_token,
    email,
    password
  };
}

function toBase64(update) {
  return Buffer.from(update).toString("base64");
}

function fromBase64(value) {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function connectClient({ projectId, docPath, userId, userName, sessionToken }) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("main");
  const docId = `${projectId}:${docPath}`;
  const query = new URLSearchParams({
    project_id: projectId,
    user_id: userId,
    user_name: userName,
    session_token: sessionToken
  });
  const wsUrl = `${REALTIME_WS}/v1/realtime/ws/${encodeURIComponent(docId)}?${query.toString()}`;
  const ws = new WebSocket(wsUrl);
  const origin = `stress-${userId}-${Math.random().toString(16).slice(2)}`;
  const presence = new Set([userId]);
  let opened = false;

  ws.addEventListener("open", () => {
    opened = true;
    const snapshot = Y.encodeStateAsUpdate(ydoc);
    ws.send(JSON.stringify({ kind: "yjs.sync", origin, payload: toBase64(snapshot) }));
  });

  ydoc.on("update", (update, updateOrigin) => {
    if (updateOrigin === "remote") return;
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ kind: "yjs.update", origin, payload: toBase64(update) }));
  });

  ws.addEventListener("message", (event) => {
    const parsed = JSON.parse(String(event.data));
    const kind = parsed?.kind;
    const payload = parsed?.payload;
    const sender = parsed?.user_id;
    if (kind === "presence.join" && typeof sender === "string") {
      presence.add(sender);
      if (sender !== userId && ws.readyState === WebSocket.OPEN) {
        const snapshot = Y.encodeStateAsUpdate(ydoc);
        ws.send(JSON.stringify({ kind: "yjs.sync", origin, payload: toBase64(snapshot) }));
      }
    }
    if (kind === "presence.leave" && typeof sender === "string") {
      presence.delete(sender);
    }
    if (kind === "yjs.update" || kind === "yjs.sync" || kind === "doc.update") {
      const maybe = typeof payload === "string" ? payload : payload?.payload;
      if (typeof maybe === "string") {
        Y.applyUpdate(ydoc, fromBase64(maybe), "remote");
      }
    }
  });

  return {
    ws,
    ydoc,
    ytext,
    presence,
    isOpen: () => opened && ws.readyState === WebSocket.OPEN,
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
    await wait(80);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function waitForGitMainContains(repoUrl, patToken, snippet, timeoutMs = 20000) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "typst-stress-main-"));
  const parsed = new URL(repoUrl);
  if (!parsed.username) parsed.username = "git";
  parsed.password = patToken;
  const authUrl = parsed.toString();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      run(`rm -rf ${tmp}/repo`);
      run(`git clone ${authUrl} ${tmp}/repo`);
      run("git checkout -B main origin/main", `${tmp}/repo`);
      const content = await fs.readFile(path.join(tmp, "repo", "main.typ"), "utf8");
      if (content.includes(snippet)) {
        return { repoPath: `${tmp}/repo`, content };
      }
    } catch {
      // retry
    }
    await wait(500);
  }
  throw new Error(`git main did not contain expected snippet: ${snippet}`);
}

async function main() {
  const owner = await registerOrLogin(ownerEmail, ownerPassword, "Stress Owner");
  const collaborator = await registerOrLogin(collabEmail, collabPassword, "Stress Collaborator");
  const project = await api("POST", "/v1/projects", owner.sessionToken, {
    name: `Stress ${runId}`
  });
  const projectId = project.id;
  await api("POST", `/v1/projects/${projectId}/roles`, owner.sessionToken, {
    user_id: collaborator.userId,
    role: "ReadWrite"
  });
  await api(
    "PUT",
    `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent(DOC_PATH)}`,
    owner.sessionToken,
    { content: "= Stress\n\nSeed.\n" }
  );

  const a = connectClient({
    projectId,
    docPath: DOC_PATH,
    userId: owner.userId,
    userName: "Stress Owner",
    sessionToken: owner.sessionToken
  });
  let b = connectClient({
    projectId,
    docPath: DOC_PATH,
    userId: collaborator.userId,
    userName: "Stress Collaborator",
    sessionToken: collaborator.sessionToken
  });

  await waitFor(() => a.isOpen() && b.isOpen(), 10000, "both realtime sockets open");
  await wait(250);

  for (let i = 0; i < ROUNDS; i += 1) {
    const actor = i % 2 === 0 ? a : b;
    const tag = i % 2 === 0 ? "A" : "B";
    actor.ydoc.transact(() => {
      actor.ytext.insert(actor.ytext.length, `${tag}:${i}\n`);
      if (i > 10 && i % 17 === 0 && actor.ytext.length > 12) {
        actor.ytext.delete(0, 1);
      }
    }, `${tag}-${i}`);
    if (i > 0 && i % 10 === 0) {
      await waitFor(() => a.ytext.toString() === b.ytext.toString(), 8000, `convergence-${i}`);
    }
    if (i > 0 && i % 15 === 0) {
      b.ws.close();
      await wait(200);
      b.close();
      b = connectClient({
        projectId,
        docPath: DOC_PATH,
        userId: collaborator.userId,
        userName: "Stress Collaborator",
        sessionToken: collaborator.sessionToken
      });
      await waitFor(() => b.isOpen(), 8000, `reconnect-${i}`);
    }
    await wait(45);
  }

  await waitFor(() => a.ytext.toString() === b.ytext.toString(), 12000, "final convergence");
  const finalText = a.ytext.toString();
  await api(
    "PUT",
    `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent(DOC_PATH)}`,
    owner.sessionToken,
    { content: finalText }
  );

  const revisionA = await api("POST", `/v1/projects/${projectId}/revisions`, owner.sessionToken, {
    summary: "Stress checkpoint A"
  });
  const revisionB = await api("POST", `/v1/projects/${projectId}/revisions`, owner.sessionToken, {
    summary: "Stress checkpoint B"
  });
  const revisions = await api("GET", `/v1/projects/${projectId}/revisions`, owner.sessionToken);
  if (!Array.isArray(revisions.revisions) || revisions.revisions.length < 2) {
    throw new Error("revision list did not include expected entries");
  }
  const revDocs = await api(
    "GET",
    `/v1/projects/${projectId}/revisions/${revisionA.id}/documents`,
    owner.sessionToken
  );
  if (!revDocs.documents.some((d) => d.path === DOC_PATH)) {
    throw new Error("revision documents missing main.typ");
  }
  const revDelta = await api(
    "GET",
    `/v1/projects/${projectId}/revisions/${revisionB.id}/documents?current_revision_id=${revisionA.id}&include_live_anchor=true`,
    owner.sessionToken
  );
  if (!["full", "delta"].includes(revDelta.transfer_mode ?? "full")) {
    throw new Error("unexpected revision transfer mode");
  }

  const ownerPat = await api("POST", "/v1/profile/security/tokens", owner.sessionToken, {
    label: "stress-owner"
  });
  const repoLink = await api("GET", `/v1/git/repo-link/${projectId}`, owner.sessionToken);
  const repoUrl = repoLink.repo_url;
  const parsedRepoUrl = new URL(repoUrl);
  if (!parsedRepoUrl.username) parsedRepoUrl.username = "git";
  parsedRepoUrl.password = ownerPat.token;
  const authRepoUrl = parsedRepoUrl.toString();

  const probe = await waitForGitMainContains(repoUrl, ownerPat.token, "A:", 25000);
  const offline = probe.repoPath;
  run("git config user.name 'Stress Offline'", offline);
  run("git config user.email 'stress-offline@example.com'", offline);
  await fs.writeFile(path.join(offline, "notes.typ"), `= Git Offline ${runId}\n\nline\n`, "utf8");
  await fs.writeFile(path.join(offline, "binary.bin"), Buffer.from([0, 1, 2, 3, 255, 0, 127]));
  run("git add notes.typ binary.bin", offline);
  run("git commit -m 'offline text+binary update'", offline);
  run("git push origin HEAD:main", offline);

  const startImportWait = Date.now();
  let importedOk = false;
  while (Date.now() - startImportWait < 25000) {
    const docs = await api("GET", `/v1/projects/${projectId}/documents`, owner.sessionToken);
    const assets = await api("GET", `/v1/projects/${projectId}/assets`, owner.sessionToken);
    const hasNotes = docs.documents.some((d) => d.path === "notes.typ");
    const hasBin = assets.assets.some((aInfo) => aInfo.path === "binary.bin");
    if (hasNotes && hasBin) {
      importedOk = true;
      break;
    }
    await wait(500);
  }
  if (!importedOk) {
    throw new Error("git receive-pack import did not update text+binary in DB");
  }

  const staleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "typst-stress-stale-"));
  const stale = path.join(staleRoot, "stale");
  run(`git clone ${authRepoUrl} ${stale}`);
  run("git checkout -B main origin/main", stale);
  run("git config user.name 'Stale User'", stale);
  run("git config user.email 'stale@example.com'", stale);

  await api(
    "PUT",
    `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent(DOC_PATH)}`,
    owner.sessionToken,
    { content: `${finalText}\nserver-change-${runId}\n` }
  );

  await fs.writeFile(path.join(stale, "main.typ"), "= stale\n", "utf8");
  run("git add main.typ", stale);
  run("git commit -m 'stale update'", stale);
  let staleRejected = false;
  try {
    run("git push origin HEAD:main", stale);
  } catch {
    staleRejected = true;
  }
  if (!staleRejected) {
    throw new Error("stale push unexpectedly succeeded");
  }

  run("git reset --hard HEAD~1", stale);
  let forceRejected = false;
  try {
    run("git push --force origin HEAD:main", stale);
  } catch {
    forceRejected = true;
  }
  if (!forceRejected) {
    throw new Error("force push unexpectedly succeeded");
  }

  a.close();
  b.close();

  console.log(
    JSON.stringify(
      {
        ok: true,
        projectId,
        rounds: ROUNDS,
        revisionsChecked: [revisionA.id, revisionB.id],
        finalLength: finalText.length
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
