export const PROTOCOL_EPOCH = 1;
export const PROTOCOL_EPOCH_HEADER = "x-toss-protocol-epoch";
export const PROTOCOL_INCOMPATIBLE_CLOSE_CODE = 4406;

export type ProtocolCompatibilityState = "compatible" | "reload_required";

let state: ProtocolCompatibilityState = "compatible";
const listeners = new Set<() => void>();
let webBuildProbe: Promise<void> | null = null;

const WEB_BUILD_PROBE_DEADLINE_MS = 5_000;
const WEB_BUILD_PROBE_RETRY_MS = 500;
const WEB_BUILD_FETCH_TIMEOUT_MS = 1_000;

export function protocolCompatibilityState(): ProtocolCompatibilityState {
  return state;
}

export function subscribeProtocolCompatibility(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function requireProtocolReload(): void {
  if (state === "reload_required") return;
  state = "reload_required";
  for (const listener of listeners) listener();
}

export function protocolEpochHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    ...(extra ?? {}),
    [PROTOCOL_EPOCH_HEADER]: String(PROTOCOL_EPOCH)
  };
}

export function observeProtocolResponse(response: Response): void {
  const coreEpoch = response.headers.get(PROTOCOL_EPOCH_HEADER);
  if (
    response.status === 426 ||
    (coreEpoch !== null && coreEpoch !== String(PROTOCOL_EPOCH))
  ) {
    requireProtocolReload();
  }
}

export function appendProtocolEpoch(query: URLSearchParams): void {
  query.set("protocol_epoch", String(PROTOCOL_EPOCH));
}

export function isProtocolIncompatibleClose(code: number): boolean {
  return code === PROTOCOL_INCOMPATIBLE_CLOSE_CODE;
}

function moduleEntryUrlFromHtml(html: string, baseUrl: string): string | null {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const source = parsed
    .querySelector<HTMLScriptElement>('script[type="module"][src]')
    ?.getAttribute("src");
  if (!source) return null;
  try {
    return new URL(source, baseUrl).href;
  } catch {
    return null;
  }
}

function currentModuleEntryUrl(): string | null {
  const source = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;
  if (!source) return null;
  try {
    return new URL(source, window.location.href).href;
  } catch {
    return null;
  }
}

function comparableEntryUrl(url: string): string {
  const parsed = new URL(url, window.location.href);
  return `${parsed.origin}${parsed.pathname}${parsed.search}`;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

async function fetchCurrentWebEntry(timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("/index.html", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "text/html" },
      signal: controller.signal
    });
    if (!response.ok) return null;
    return moduleEntryUrlFromHtml(
      await response.text(),
      response.url || window.location.href
    );
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function probeCurrentWebBuild(currentEntryUrl: string): Promise<void> {
  const deadline = Date.now() + WEB_BUILD_PROBE_DEADLINE_MS;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const latestEntryUrl = await fetchCurrentWebEntry(
      Math.min(WEB_BUILD_FETCH_TIMEOUT_MS, remaining)
    );
    if (latestEntryUrl !== null) {
      if (comparableEntryUrl(latestEntryUrl) !== comparableEntryUrl(currentEntryUrl)) {
        requireProtocolReload();
      }
      return;
    }
    const retryWindow = deadline - Date.now();
    if (retryWindow <= 0) break;
    await wait(Math.min(WEB_BUILD_PROBE_RETRY_MS, retryWindow));
  }
  requireProtocolReload();
}

export async function handleLazyChunkLoadFailure(event: Event): Promise<void> {
  event.preventDefault();
  const currentEntryUrl = currentModuleEntryUrl();
  if (!currentEntryUrl) {
    requireProtocolReload();
    return;
  }

  const probe = webBuildProbe ?? probeCurrentWebBuild(currentEntryUrl);
  webBuildProbe = probe;
  try {
    await probe;
  } finally {
    if (webBuildProbe === probe) webBuildProbe = null;
  }
}

export function resetProtocolCompatibilityForTest(): void {
  state = "compatible";
  listeners.clear();
  webBuildProbe = null;
}
