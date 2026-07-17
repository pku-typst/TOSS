import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const POLL_INTERVAL_MS = 100;

export const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await check()) return Date.now();
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const suffix = lastError ? `: ${String(lastError)}` : "";
  throw new Error(`Timed out waiting for ${label}${suffix}`);
}

export async function holdIncompleteRequestBody({
  coreApi,
  method,
  route,
  token,
  timeoutMs,
}) {
  const endpoint = new URL(coreApi);
  const port = Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80));
  const socket = net.createConnection({ host: endpoint.hostname, port });
  const response = [];
  const admitted = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for the incomplete request body to be admitted"));
    }, timeoutMs);
    const settle = (callback, value) => {
      clearTimeout(timer);
      socket.off("error", onError);
      callback(value);
    };
    const onError = (error) => settle(reject, error);
    socket.on("error", onError);
    socket.on("data", (chunk) => {
      response.push(chunk);
      const prefix = Buffer.concat(response).toString("latin1");
      if (prefix.includes("100 Continue\r\n\r\n")) {
        settle(resolve);
      } else if (/^HTTP\/1\.1 (?!100 )\d{3}/.test(prefix)) {
        settle(
          reject,
          new Error(`Incomplete request was rejected before admission: ${prefix}`),
        );
      }
    });
  });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    [
      `${method} ${route} HTTP/1.1`,
      `Host: ${endpoint.host}`,
      `Authorization: Bearer ${token}`,
      "Content-Type: application/json",
      "Content-Length: 1048576",
      "Expect: 100-continue",
      "Connection: keep-alive",
      "",
      "",
    ].join("\r\n"),
  );
  await admitted;
  return socket;
}

export function createCoreProcessHarness({
  coreApi,
  coreBinary,
  corePort,
  dataDir,
  deploymentConfig,
  distributionConfig,
  gitStoragePath,
  logDir,
  repoRoot,
  startupTimeoutMs,
  stopTimeoutMs,
  webStaticDir,
}) {
  async function readLogTail(logPath, lineCount = 80) {
    const raw = await fs.readFile(logPath, "utf8").catch(() => "");
    return raw.split("\n").slice(-lineCount).join("\n");
  }

  function startCore(label, additionalEnv = {}) {
    const logPath = path.join(logDir, `core-${label}.log`);
    const log = createWriteStream(logPath, { flags: "w" });
    const child = spawn(coreBinary, [], {
      cwd: path.join(repoRoot, "backend"),
      env: {
        ...process.env,
        ...additionalEnv,
        AUTH_DEV_HEADER_ENABLED: "1",
        CORE_API_PORT: String(corePort),
        DATA_DIR: dataDir,
        GIT_STORAGE_PATH: gitStoragePath,
        TOSS_CONFIG: distributionConfig,
        TOSS_DEPLOYMENT_CONFIG: deploymentConfig,
        WEB_STATIC_DIR: webStaticDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });

    const exit = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        log.end();
        resolve({ code, signal });
      });
    });
    return { child, exit, label, logPath, startedAt: Date.now() };
  }

  async function waitForCoreReady(core) {
    const readyAt = await waitFor(
      async () => {
        if (core.child.exitCode !== null || core.child.signalCode !== null) {
          const tail = await readLogTail(core.logPath);
          throw new Error(`Core ${core.label} exited during startup\n${tail}`);
        }
        const response = await fetch(`${coreApi}/ready`, {
          signal: AbortSignal.timeout(750),
        });
        return response.ok;
      },
      startupTimeoutMs,
      `Core ${core.label} readiness`
    );
    return readyAt - core.startedAt;
  }

  async function stopCore(core, signal = "SIGTERM") {
    if (core.child.exitCode !== null || core.child.signalCode !== null) {
      return { ...(await core.exit), durationMs: 0, forced: false };
    }
    const signaledAt = Date.now();
    core.child.kill(signal);
    const timeout = Symbol("stop-timeout");
    const result = await Promise.race([
      core.exit,
      sleep(stopTimeoutMs).then(() => timeout),
    ]);
    if (result !== timeout) {
      return {
        ...result,
        durationMs: Date.now() - signaledAt,
        forced: false,
      };
    }
    core.child.kill("SIGKILL");
    const forcedResult = await core.exit;
    return {
      ...forcedResult,
      durationMs: Date.now() - signaledAt,
      forced: true,
    };
  }

  return { readLogTail, startCore, stopCore, waitForCoreReady };
}
