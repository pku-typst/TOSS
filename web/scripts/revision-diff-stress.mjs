import crypto from "node:crypto";
import { projectContentEpochHeader } from "./lib/project-content-epoch.mjs";

const baseUrl = process.env.CORE_API_URL ?? "http://127.0.0.1:18080";
const runId = Date.now().toString();
const ownerEmail = `rev-diff-owner-${runId}@example.com`;
const ownerPassword = "Owner1234!";

function hashState(state) {
  const hash = crypto.createHash("sha256");
  const docEntries = Object.entries(state.docs).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [path, content] of docEntries) {
    hash.update("D:");
    hash.update(path);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  const assetEntries = Object.entries(state.assets).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [path, asset] of assetEntries) {
    hash.update("A:");
    hash.update(path);
    hash.update("\0");
    hash.update(asset.content_type || "");
    hash.update("\0");
    hash.update(String(asset.size_bytes || 0));
    hash.update("\0");
    hash.update(asset.content_base64 || "");
    hash.update("\0");
  }
  return hash.digest("hex");
}

function normalizeNodes(nodes) {
  return (nodes || [])
    .map((n) => `${n.kind}:${n.path}`)
    .sort();
}

async function parseJson(res) {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON (${res.status}): ${text.slice(0, 200)}`);
  }
}

async function bearerApi(method, route, token, body) {
  const contentEpochHeader = await projectContentEpochHeader(baseUrl, method, route, token);
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
      ...contentEpochHeader
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await parseJson(res);
  if (!res.ok) throw new Error(`${method} ${route} failed (${res.status}): ${JSON.stringify(payload)}`);
  return payload;
}

async function fetchRevisionRaw(projectId, revisionId, token, options = {}) {
  const params = new URLSearchParams();
  if (options.currentRevisionId) params.set("current_revision_id", options.currentRevisionId);
  if (typeof options.includeLiveAnchor === "boolean") {
    params.set("include_live_anchor", options.includeLiveAnchor ? "true" : "false");
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const res = await fetch(
    `${baseUrl}/v1/projects/${projectId}/revisions/${revisionId}/documents${query}`,
    {
      headers: { authorization: `Bearer ${token}` }
    }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`GET revision ${revisionId} failed (${res.status}): ${text.slice(0, 200)}`);
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    json: JSON.parse(text)
  };
}

function applyRevisionResponse(response, baselineState) {
  const docs = { ...(baselineState?.docs || {}) };
  const assets = { ...(baselineState?.assets || {}) };
  for (const path of response.deleted_documents || []) delete docs[path];
  for (const doc of response.documents || []) docs[doc.path] = doc.content;
  for (const path of response.deleted_assets || []) delete assets[path];
  for (const asset of response.assets || []) {
    assets[asset.path] = {
      content_type: asset.content_type,
      size_bytes: asset.size_bytes,
      content_base64: asset.content_base64
    };
  }
  return { docs, assets, nodes: response.nodes || [] };
}

async function registerOrLogin(email, password, displayName) {
  const emailPrefix = email.split("@")[0] || "user";
  const username = emailPrefix.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 32) || `user${Date.now()}`;
  const registerRes = await fetch(`${baseUrl}/v1/auth/local/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, username, display_name: displayName })
  });
  if (registerRes.ok) return parseJson(registerRes);
  if (registerRes.status !== 403 && registerRes.status !== 409) {
    throw new Error(`register failed (${registerRes.status})`);
  }
  const loginRes = await fetch(`${baseUrl}/v1/auth/local/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  if (!loginRes.ok) {
    const text = await loginRes.text();
    throw new Error(`login failed (${loginRes.status}): ${text}`);
  }
  return parseJson(loginRes);
}

async function main() {
  const account = await registerOrLogin(ownerEmail, ownerPassword, "Revision Diff Owner");
  const token = account.session_token;
  if (!token) throw new Error("missing session_token");

  const project = await bearerApi("POST", "/v1/projects", token, { name: `Revision Diff Stress ${runId}` });
  const projectId = project.id;

  let mainContent = "#set text(font: \"Libertinus Serif\")\n= Revision Diff Stress\n";
  let chapterContent = "= Chapter\n";

  const revisionIds = [];
  const revisionCount = 40;
  for (let i = 1; i <= revisionCount; i += 1) {
    mainContent += `\nLine ${i}: ${"x".repeat(80 + (i % 7) * 13)}`;
    if (i % 3 === 0) {
      chapterContent += `\nChapter line ${i}: ${"y".repeat(40 + (i % 5) * 11)}`;
    }
    await bearerApi(
      "PUT",
      `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent("main.typ")}`,
      token,
      { content: mainContent }
    );
    await bearerApi(
      "PUT",
      `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent("chapters/intro.typ")}`,
      token,
      { content: chapterContent }
    );
    if (i % 8 === 0) {
      const blob = Buffer.from(`asset-${i}-${"z".repeat(12000 + i * 300)}`).toString("base64");
      await bearerApi("POST", `/v1/projects/${projectId}/assets`, token, {
        path: "figures/sample.bin",
        content_base64: blob,
        content_type: "application/octet-stream"
      });
    }
    const rev = await bearerApi("POST", `/v1/projects/${projectId}/revisions`, token, {
      summary: `stress revision ${i}`
    });
    revisionIds.push(rev.id);
  }

  const revisions = (
    await bearerApi("GET", `/v1/projects/${projectId}/revisions`, token)
  ).revisions.map((r) => r.id);
  if (revisions.length < 10) throw new Error("not enough revisions created");

  const liveDocsRes = await bearerApi("GET", `/v1/projects/${projectId}/documents`, token);
  const liveAssetsRes = await bearerApi("GET", `/v1/projects/${projectId}/assets`, token);
  const liveDocs = {};
  for (const doc of liveDocsRes.documents || []) {
    liveDocs[doc.path] = doc.content;
  }
  const liveAssets = {};
  for (const asset of liveAssetsRes.assets || []) {
    const payload = await bearerApi("GET", `/v1/projects/${projectId}/assets/${asset.id}`, token);
    liveAssets[payload.asset.path] = {
      content_type: payload.asset.content_type,
      size_bytes: payload.asset.size_bytes,
      content_base64: payload.content_base64
    };
  }
  const liveState = { docs: liveDocs, assets: liveAssets };

  const cachedRevisionStates = new Map();
  let currentRevisionId = null;
  let deltaCount = 0;
  let fullCount = 0;
  let usedLiveAnchor = 0;
  let usedRevisionAnchor = 0;
  let anchoredBytesTotal = 0;
  let fullBytesTotal = 0;

  const sequence = [];
  for (let i = 0; i < 120; i += 1) {
    sequence.push(revisions[Math.floor(Math.random() * revisions.length)]);
  }

  for (const targetRevisionId of sequence) {
    const anchoredRaw = await fetchRevisionRaw(projectId, targetRevisionId, token, {
      currentRevisionId,
      includeLiveAnchor: true
    });
    anchoredBytesTotal += anchoredRaw.bytes;

    let baselineState = null;
    if ((anchoredRaw.json.transfer_mode || "full") === "delta") {
      if (anchoredRaw.json.base_anchor === "live") {
        baselineState = liveState;
        usedLiveAnchor += 1;
      } else if (
        anchoredRaw.json.base_anchor === "revision" &&
        anchoredRaw.json.base_revision_id &&
        cachedRevisionStates.has(anchoredRaw.json.base_revision_id)
      ) {
        baselineState = cachedRevisionStates.get(anchoredRaw.json.base_revision_id);
        usedRevisionAnchor += 1;
      }
    }
    if ((anchoredRaw.json.transfer_mode || "full") === "delta") deltaCount += 1;
    else fullCount += 1;

    let applied = applyRevisionResponse(anchoredRaw.json, baselineState);
    if ((anchoredRaw.json.transfer_mode || "full") === "delta" && !baselineState) {
      const fallbackFull = await fetchRevisionRaw(projectId, targetRevisionId, token, {
        includeLiveAnchor: false
      });
      applied = applyRevisionResponse(fallbackFull.json, null);
      anchoredBytesTotal += fallbackFull.bytes;
      fullCount += 1;
    }

    const fullRaw = await fetchRevisionRaw(projectId, targetRevisionId, token, {
      includeLiveAnchor: false
    });
    fullBytesTotal += fullRaw.bytes;
    const fullApplied = applyRevisionResponse(fullRaw.json, null);

    if (hashState(applied) !== hashState(fullApplied)) {
      throw new Error(`state mismatch on revision ${targetRevisionId}`);
    }
    const anchoredNodes = normalizeNodes(anchoredRaw.json.nodes);
    const fullNodes = normalizeNodes(fullRaw.json.nodes);
    if (anchoredNodes.join("\n") !== fullNodes.join("\n")) {
      throw new Error(`node mismatch on revision ${targetRevisionId}`);
    }

    cachedRevisionStates.set(targetRevisionId, fullApplied);
    currentRevisionId = targetRevisionId;
  }

  const savedPercent =
    fullBytesTotal > 0
      ? Math.round(((fullBytesTotal - anchoredBytesTotal) / fullBytesTotal) * 100)
      : 0;

  console.log(
    JSON.stringify(
      {
        ok: true,
        projectId,
        revisionsCreated: revisions.length,
        switches: sequence.length,
        deltaCount,
        fullCount,
        usedLiveAnchor,
        usedRevisionAnchor,
        anchoredBytesTotal,
        fullBytesTotal,
        estimatedBandwidthSavedPercent: savedPercent
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
  process.exit(1);
});
