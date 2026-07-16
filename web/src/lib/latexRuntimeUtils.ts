import type { CompileDiagnostic } from "./typst";

const MAX_WORKSPACE_PATH_BYTES = 1024;
const MAX_WORKSPACE_SEGMENT_BYTES = 255;
const MAX_COMPILE_FILES = 4096;
const MAX_SOURCE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ASSET_FILE_BYTES = 64 * 1024 * 1024;
const MAX_COMPILE_TOTAL_BYTES = 128 * 1024 * 1024;
const TEXLIVE_TEX_FORMAT = 26;
const GENERATED_AUXILIARY_SUFFIXES = [
  ".acn",
  ".acr",
  ".alg",
  ".aux",
  ".bbl",
  ".bcf",
  ".blg",
  ".brf",
  ".fdb_latexmk",
  ".fls",
  ".glo",
  ".gls",
  ".idx",
  ".ilg",
  ".ind",
  ".loa",
  ".lof",
  ".lol",
  ".lot",
  ".nav",
  ".nlo",
  ".nls",
  ".out",
  ".run.xml",
  ".snm",
  ".thm",
  ".toc",
  ".vrb",
] as const;

type LatexCompileInput = {
  documents: Array<{ path: string; content: string }>;
  assets: Array<{ path: string; contentBase64: string }>;
};

export function normalizeLatexWorkspacePath(path: string, fallback = "") {
  const requested = path.trim().replace(/^\/+/, "");
  const clean = requested || fallback.trim().replace(/^\/+/, "");
  if (!clean) return "";
  const encoder = new TextEncoder();
  if (encoder.encode(clean).byteLength > MAX_WORKSPACE_PATH_BYTES || clean.includes("\\")) {
    throw new Error("Invalid LaTeX workspace path");
  }
  const parts = clean.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        encoder.encode(part).byteLength > MAX_WORKSPACE_SEGMENT_BYTES ||
        /[\u0000-\u001f\u007f]/.test(part)
    )
  ) {
    throw new Error("Invalid LaTeX workspace path");
  }
  return parts.join("/");
}

export function isLatexGeneratedAuxiliaryPath(path: string) {
  const filename = path.split("/").at(-1)?.toLowerCase() ?? "";
  return GENERATED_AUXILIARY_SUFFIXES.some((suffix) => filename.endsWith(suffix));
}

export function latexGeneratedAuxiliaryMissKeys(
  documents: Array<{ path: string }>,
) {
  const misses = new Set<string>();
  for (const document of documents) {
    const filename = document.path.split("/").at(-1) ?? "";
    const lowercase = filename.toLowerCase();
    const sourceSuffix = lowercase.endsWith(".tex")
      ? ".tex"
      : lowercase.endsWith(".ltx")
        ? ".ltx"
        : null;
    if (!sourceSuffix) continue;
    const stem = filename.slice(0, -sourceSuffix.length);
    if (!stem) continue;
    for (const suffix of GENERATED_AUXILIARY_SUFFIXES) {
      misses.add(`${TEXLIVE_TEX_FORMAT}/${stem}${suffix}`);
    }
  }
  return Array.from(misses).sort((left, right) => left.localeCompare(right));
}

function base64DecodedLength(value: string) {
  if (!value) return 0;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Invalid LaTeX asset encoding");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export function validateLatexCompileInput(input: LatexCompileInput) {
  const fileCount = input.documents.length + input.assets.length;
  if (fileCount > MAX_COMPILE_FILES) {
    throw new Error("LaTeX project has too many compile files");
  }

  const seenPaths = new Set<string>();
  let totalBytes = 0;
  const addFile = (path: string, size: number, maxSize: number) => {
    const normalized = normalizeLatexWorkspacePath(path);
    if (!normalized) throw new Error("Invalid LaTeX workspace path");
    if (seenPaths.has(normalized)) throw new Error("Duplicate LaTeX workspace path");
    seenPaths.add(normalized);
    if (size > maxSize) throw new Error("LaTeX compile file is too large");
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_COMPILE_TOTAL_BYTES) {
      throw new Error("LaTeX compile input exceeds the browser memory limit");
    }
  };

  const encoder = new TextEncoder();
  for (const document of input.documents) {
    addFile(document.path, encoder.encode(document.content).byteLength, MAX_SOURCE_FILE_BYTES);
  }
  for (const asset of input.assets) {
    addFile(asset.path, base64DecodedLength(asset.contentBase64), MAX_ASSET_FILE_BYTES);
  }
}

export function parseLatexCompileDiagnostics(log: string): CompileDiagnostic[] {
  const lines = log.split(/\r?\n/);
  const diagnostics: CompileDiagnostic[] = [];
  const pattern =
    /^(?<path>[^:\r\n]+?\.(?:tex|ltx|sty|cls|bib)):(?<line>\d+):\s*(?<message>.+)$/i;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = (lines[i] ?? "").trim();
    if (!raw) continue;
    const match = raw.match(pattern);
    if (match?.groups) {
      diagnostics.push({
        severity: "error",
        path: match.groups.path.replace(/^\.\/+/, ""),
        line: Number.parseInt(match.groups.line, 10),
        column: 1,
        message: match.groups.message.trim(),
        raw
      });
      continue;
    }
    if (!/^!/.test(raw) && !/error/i.test(raw)) continue;
    let contextualRaw = raw;
    if (/^!/.test(raw)) {
      const context: string[] = [];
      for (let j = i - 1; j >= 0; j -= 1) {
        const previous = (lines[j] ?? "").trim();
        if (!previous) continue;
        if (/^\(/.test(previous) || /^l\.\d+/.test(previous) || /\.\w+\)?$/.test(previous)) {
          context.push(previous);
        }
        break;
      }
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = (lines[j] ?? "").trim();
        if (!next) {
          if (context.length > 0) break;
          continue;
        }
        if (/^!/.test(next)) break;
        context.push(next);
        if (/^l\.\d+/.test(next) || context.length >= 3) break;
      }
      if (context.length > 0) contextualRaw = `${raw} ${context.join(" ")}`;
    }
    diagnostics.push({
      severity: "error",
      message: contextualRaw.replace(/^!\s*/, ""),
      raw: contextualRaw
    });
  }
  return diagnostics;
}

export function summarizeLatexCompileErrors(log: string) {
  const lines = log.split(/\r?\n/);
  const primary: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = (lines[i] ?? "").trim();
    if (!raw.startsWith("!")) continue;
    const block: string[] = [raw];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = (lines[j] ?? "").trim();
      if (!next) {
        if (block.length > 1) break;
        continue;
      }
      if (next.startsWith("!")) break;
      block.push(next);
      if (/^l\.\d+/.test(next) || block.length >= 4) break;
    }
    primary.push(block.join(" "));
    if (primary.length >= 6) break;
  }
  if (primary.length > 0) return primary;
  const nonEmpty = lines.map((line) => line.trim()).filter(Boolean);
  return nonEmpty.length > 0 ? nonEmpty.slice(-8) : ["LaTeX compile failed"];
}
