export const AI_RUNTIME_NONCE_MARKER =
  'data-toss-ai-nonce="__TOSS_AI_RUNTIME_NONCE__"';
export const AI_RUNTIME_BOOTSTRAP_MARKER = 'data-toss-ai-bootstrap="true"';

const MODULE_SCRIPT_PATTERN = /<script\b[^>]*\btype=(?:"module"|'module')[^>]*><\/script>/g;

export function decorateAiRuntimeEntry(html: string) {
  const moduleScripts = html.match(MODULE_SCRIPT_PATTERN) ?? [];
  if (moduleScripts.length !== 1) {
    throw new Error(
      `AI Runtime entry must contain exactly one module script; found ${moduleScripts.length}`
    );
  }

  const original = moduleScripts[0];
  let decorated = original;
  if (!decorated.includes(AI_RUNTIME_BOOTSTRAP_MARKER)) {
    decorated = decorated.replace("<script", `<script ${AI_RUNTIME_BOOTSTRAP_MARKER}`);
  }
  if (!decorated.includes(AI_RUNTIME_NONCE_MARKER)) {
    decorated = decorated.replace("<script", `<script ${AI_RUNTIME_NONCE_MARKER}`);
  }
  return html.replace(original, decorated);
}
