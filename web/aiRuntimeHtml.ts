export const AI_RUNTIME_NONCE_MARKER =
  'data-toss-ai-nonce="__TOSS_AI_RUNTIME_NONCE__"';
export const AI_RUNTIME_POLICY_MARKER =
  'data-toss-ai-policy="__TOSS_AI_RUNTIME_POLICY__"';

const CSP_SLOT = "<!-- TOSS_AI_RUNTIME_CSP -->";
const SCRIPT_SLOT = "<!-- TOSS_AI_RUNTIME_SCRIPT -->";

type CoreRuntimeEntry = {
  kind: "core";
  scriptSrc: string;
};

type StaticRuntimeEntry = {
  kind: "static";
  scriptSource: string;
  nonce: string;
  encodedPolicy: string;
  connectSources: readonly string[];
};

const STATIC_LOOPBACK_CONNECT_SOURCES = new Set([
  "http://localhost:*",
  "http://127.0.0.1:*",
]);

function replaceSlot(template: string, slot: string, value: string) {
  if (template.split(slot).length !== 2) {
    throw new Error(`AI Runtime template must contain exactly one ${slot} slot`);
  }
  return template.replace(slot, () => value);
}

function escapeHtmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function staticContentSecurityPolicy(options: StaticRuntimeEntry) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(options.nonce)) {
    throw new Error("Static AI Runtime nonce is invalid");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(options.encodedPolicy)) {
    throw new Error("Static AI Runtime policy encoding is invalid");
  }
  if (
    options.connectSources.length === 0 ||
    options.connectSources.length > 8 ||
    new Set(options.connectSources).size !== options.connectSources.length ||
    options.connectSources.some((source) => {
      if (source === "https:" || STATIC_LOOPBACK_CONNECT_SOURCES.has(source)) {
        return false;
      }
      try {
        const url = new URL(source);
        return (
          url.protocol !== "https:" ||
          url.username !== "" ||
          url.password !== "" ||
          url.origin !== source
        );
      } catch {
        return true;
      }
    })
  ) {
    throw new Error("Static AI Runtime connect sources are invalid");
  }
  return [
    "default-src 'none'",
    `script-src 'nonce-${options.nonce}' 'strict-dynamic'`,
    `connect-src ${options.connectSources.join(" ")}`,
    `style-src 'nonce-${options.nonce}'`,
    "worker-src 'none'",
    "img-src 'none'",
    "font-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

function coreScript(options: CoreRuntimeEntry) {
  if (!options.scriptSrc || /[\u0000-\u001f\u007f]/u.test(options.scriptSrc)) {
    throw new Error("Core AI Runtime script URL is invalid");
  }
  return `<script type="module" crossorigin src="${escapeHtmlAttribute(options.scriptSrc)}" data-toss-ai-bootstrap="true" ${AI_RUNTIME_NONCE_MARKER} ${AI_RUNTIME_POLICY_MARKER}></script>`;
}

function staticScript(options: StaticRuntimeEntry) {
  const source = options.scriptSource.replace(/<\/script/giu, "<\\/script");
  return `<script type="module" data-toss-ai-bootstrap="true" nonce="${options.nonce}" data-toss-ai-policy="${options.encodedPolicy}">${source}</script>`;
}

export function renderAiRuntimeEntry(
  template: string,
  options: CoreRuntimeEntry | StaticRuntimeEntry,
) {
  const csp =
    options.kind === "static"
      ? `<meta http-equiv="Content-Security-Policy" content="${staticContentSecurityPolicy(options)}" />`
      : "";
  const script =
    options.kind === "static" ? staticScript(options) : coreScript(options);
  const rendered = replaceSlot(
    replaceSlot(template, CSP_SLOT, csp),
    SCRIPT_SLOT,
    script,
  );
  if (rendered.includes(CSP_SLOT) || rendered.includes(SCRIPT_SLOT)) {
    throw new Error("AI Runtime template contains unresolved slots");
  }
  return rendered;
}
