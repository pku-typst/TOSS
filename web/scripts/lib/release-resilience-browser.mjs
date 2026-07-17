import { waitFor } from "./release-resilience-process.mjs";

const SERVICE_RESTART_CLOSE_CODE = 1012;

export function createReleaseResilienceBrowserHarness({ coreApi, timeoutMs }) {
  async function login(page, account) {
    await page.goto(`${coreApi}/signin`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.locator('input[name="email"]').fill(account.email);
    await page.locator('input[name="password"]').fill(account.password);
    await page.locator(".auth-submit").click();
    await page.waitForURL((url) => url.pathname === "/projects", {
      timeout: timeoutMs,
    });
    await page.locator("section.app-page").waitFor({ timeout: timeoutMs });
  }

  async function openWorkspace(page, projectId) {
    await page.goto(`${coreApi}/project/${projectId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.locator(".cm-content").first().waitFor({ timeout: timeoutMs });
    const mainFile = page.locator(".tree-label", { hasText: "main.typ" }).first();
    if (await mainFile.count()) await mainFile.click();
  }

  async function editorText(page) {
    return page.locator(".cm-content").first().innerText();
  }

  function countOccurrences(text, marker) {
    return text.split(marker).length - 1;
  }

  async function waitForEditorText(page, marker, label) {
    await waitFor(
      async () => (await editorText(page)).includes(marker),
      timeoutMs,
      label
    );
  }

  async function appendEditorText(page, text) {
    const editor = page.locator(".cm-content").first();
    await editor.click();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End"
    );
    await page.keyboard.insertText(`\n${text}\n`);
  }

  async function saveEditor(page) {
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+s" : "Control+s"
    );
  }

  async function installRealtimeProbe(context) {
    await context.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      const probe = { events: [], holdMutations: false };
      const websocketProxy = new Proxy(NativeWebSocket, {
        construct(Target, args) {
          const socket = new Target(...args);
          let pathname = "unknown";
          try {
            pathname = new URL(socket.url, window.location.href).pathname;
          } catch {
            // The test records only a sanitized path, never query credentials.
          }
          if (pathname.startsWith("/v1/realtime/")) {
            const nativeSend = socket.send.bind(socket);
            Object.defineProperty(socket, "send", {
              configurable: true,
              value(data) {
                if (
                  probe.holdMutations &&
                  pathname.startsWith("/v1/realtime/ws/") &&
                  typeof data === "string"
                ) {
                  try {
                    const message = JSON.parse(data);
                    if (
                      message?.kind === "yjs.update" ||
                      message?.kind === "yjs.sync"
                    ) {
                      probe.events.push({
                        kind: "held",
                        pathname,
                        at: Date.now(),
                      });
                      return;
                    }
                  } catch {
                    // Malformed data still follows the native transport path.
                  }
                }
                nativeSend(data);
              },
              writable: true,
            });
            socket.addEventListener("open", () => {
              probe.events.push({ kind: "open", pathname, at: Date.now() });
            });
            socket.addEventListener("message", (event) => {
              if (typeof event.data !== "string") return;
              try {
                const message = JSON.parse(event.data);
                if (message?.kind === "yjs.ack") {
                  probe.events.push({ kind: "ack", pathname, at: Date.now() });
                }
              } catch {
                // Non-JSON transport data is outside this protocol probe.
              }
            });
            socket.addEventListener("close", (event) => {
              probe.events.push({
                kind: "close",
                pathname,
                at: Date.now(),
                code: event.code,
              });
            });
          }
          return socket;
        },
      });
      Object.defineProperty(window, "WebSocket", {
        configurable: true,
        value: websocketProxy,
        writable: true,
      });
      Object.defineProperty(window, "__tossReleaseResilienceProbe", {
        configurable: false,
        value: probe,
        writable: false,
      });
    });
  }

  async function realtimeEvents(page) {
    return page.evaluate(
      () => window.__tossReleaseResilienceProbe?.events.slice() ?? []
    );
  }

  function eventCounts(events, kind) {
    const counts = new Map();
    for (const event of events) {
      if (event.kind !== kind) continue;
      counts.set(event.pathname, (counts.get(event.pathname) ?? 0) + 1);
    }
    return counts;
  }

  async function realtimeBaseline(page) {
    const events = await realtimeEvents(page);
    return {
      opens: eventCounts(events, "open"),
      closes: eventCounts(events, "close"),
      acknowledgements: eventCounts(events, "ack"),
      heldMutations: eventCounts(events, "held"),
    };
  }

  async function setMutationHold(page, enabled) {
    await page.evaluate((next) => {
      const probe = window.__tossReleaseResilienceProbe;
      if (!probe) throw new Error("Realtime probe is unavailable");
      probe.holdMutations = next;
    }, enabled);
  }

  async function waitForHeldMutation(page, baseline, label) {
    return waitFor(
      async () => {
        const held = eventCounts(await realtimeEvents(page), "held");
        const documentPaths = [...baseline.opens.keys()].filter((pathname) =>
          pathname.startsWith("/v1/realtime/ws/")
        );
        return (
          documentPaths.length > 0 &&
          documentPaths.every(
            (pathname) =>
              (held.get(pathname) ?? 0) >
              (baseline.heldMutations.get(pathname) ?? 0)
          )
        );
      },
      timeoutMs,
      `${label} held mutation`
    );
  }

  async function waitForInitialRealtime(page, label) {
    await waitFor(
      async () => {
        const events = await realtimeEvents(page);
        const opens = eventCounts(events, "open");
        const acknowledgements = eventCounts(events, "ack");
        return (
          [...opens.keys()].some((pathname) =>
            pathname.startsWith("/v1/realtime/projects/")
          ) &&
          [...opens.keys()].some((pathname) =>
            pathname.startsWith("/v1/realtime/ws/")
          ) &&
          [...acknowledgements.keys()].some((pathname) =>
            pathname.startsWith("/v1/realtime/ws/")
          )
        );
      },
      timeoutMs,
      `${label} document and project-control sockets`
    );
    return realtimeBaseline(page);
  }

  async function waitForRealtimeAcknowledgement(page, baseline, label) {
    return waitFor(
      async () => {
        const acknowledgements = eventCounts(await realtimeEvents(page), "ack");
        const documentAcknowledgements = [
          ...baseline.acknowledgements.entries(),
        ].filter(([pathname]) => pathname.startsWith("/v1/realtime/ws/"));
        return (
          documentAcknowledgements.length > 0 &&
          documentAcknowledgements.every(
            ([pathname, count]) =>
              (acknowledgements.get(pathname) ?? 0) > count
          )
        );
      },
      timeoutMs,
      `${label} persistence acknowledgement`
    );
  }

  async function waitForRealtimeClosed(page, baseline, label) {
    return waitFor(
      async () => {
        const events = await realtimeEvents(page);
        return [...baseline.opens.keys()].every((pathname) => {
          const baselineCount = baseline.closes.get(pathname) ?? 0;
          const newCloses = events
            .filter(
              (event) =>
                event.kind === "close" && event.pathname === pathname
            )
            .slice(baselineCount);
          return newCloses.some(
            (event) => event.code === SERVICE_RESTART_CLOSE_CODE
          );
        });
      },
      timeoutMs,
      `${label} service-restart socket closure`
    );
  }

  async function waitForRealtimeReopened(page, baseline, label) {
    return waitFor(
      async () => {
        const opens = eventCounts(await realtimeEvents(page), "open");
        return [...baseline.opens.entries()].every(
          ([pathname, count]) => (opens.get(pathname) ?? 0) > count
        );
      },
      timeoutMs,
      `${label} socket reconnection`
    );
  }

  return {
    appendEditorText,
    countOccurrences,
    editorText,
    installRealtimeProbe,
    login,
    openWorkspace,
    realtimeBaseline,
    saveEditor,
    setMutationHold,
    waitForEditorText,
    waitForHeldMutation,
    waitForInitialRealtime,
    waitForRealtimeAcknowledgement,
    waitForRealtimeClosed,
    waitForRealtimeReopened,
  };
}
