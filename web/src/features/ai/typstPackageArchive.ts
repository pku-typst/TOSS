import { parseTar, type ParsedTarFileItem } from "nanotar";
import {
  AI_WORKSPACE_TOOL_LIMITS,
  type AiListTypstPackageFilesArguments,
  type AiListTypstPackageFilesResult,
  type AiReadTypstPackageFileArguments,
  type AiReadTypstPackageFileResult,
  type AiSearchTypstPackageTextArguments,
  type AiSearchTypstPackageTextResult,
  type AiWorkspaceToolErrorCode
} from "@/features/ai/toolContract";
import type { TypstPackageSource } from "@/lib/typstUniverse";

const MAX_PACKAGE_FILES = 4_096;
const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_SEARCH_RESULTS = 50;
const SHA256_HEADER = "x-typst-package-sha256";

export type TypstPackageSpec = {
  namespace: "local" | "preview";
  name: string;
  version: string;
  canonical: string;
};

type PackageFile = {
  kind: "file";
  path: string;
  size: number;
  data: Uint8Array;
  text: string | null | undefined;
};

type PackageDirectory = {
  kind: "directory";
  path: string;
};

type PackageEntry = PackageFile | PackageDirectory;

export type LoadedTypstPackage = {
  spec: TypstPackageSpec;
  digest: string;
  memoryBytes: number;
  entries: ReadonlyMap<string, PackageEntry>;
};

export class TypstPackageInspectionError extends Error {
  constructor(
    readonly code: AiWorkspaceToolErrorCode,
    message: string
  ) {
    super(message);
    this.name = "TypstPackageInspectionError";
  }
}

function validSemverIdentifier(value: string, allowLeadingZero: boolean) {
  if (!value || !/^[0-9A-Za-z-]+$/.test(value)) return false;
  return allowLeadingZero || !/^\d+$/.test(value) || value === "0" || !value.startsWith("0");
}

function isCanonicalSemver(value: string) {
  if (!value || value.length > 128) return false;
  const [versionAndPrerelease, ...buildParts] = value.split("+");
  if (buildParts.length > 1) return false;
  if (buildParts.length === 1 && (
    !buildParts[0] ||
    !buildParts[0].split(".").every((part) => validSemverIdentifier(part, true))
  )) return false;
  const [core, ...prereleaseParts] = versionAndPrerelease.split("-");
  const coreParts = core.split(".");
  if (
    coreParts.length !== 3 ||
    !coreParts.every((part) => /^(?:0|[1-9]\d*)$/.test(part))
  ) return false;
  if (prereleaseParts.length > 0) {
    const prerelease = prereleaseParts.join("-");
    if (!prerelease.split(".").every((part) => validSemverIdentifier(part, false))) return false;
  }
  return true;
}

export function parseTypstPackageSpec(value: string): TypstPackageSpec | null {
  if (value.length > AI_WORKSPACE_TOOL_LIMITS.maxPackageSpecLength) return null;
  const match = /^@(local|preview)\/([^:]+):(.+)$/.exec(value);
  if (!match) return null;
  const [, namespace, name, version] = match;
  if (
    name.length === 0 ||
    name.length > 64 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name) ||
    !isCanonicalSemver(version)
  ) return null;
  return {
    namespace: namespace as TypstPackageSpec["namespace"],
    name,
    version,
    canonical: value
  };
}

function normalizePackagePath(value: string, allowEmpty: boolean) {
  const withoutTrailingSlash = value.endsWith("/") ? value.slice(0, -1) : value;
  if (!withoutTrailingSlash) return allowEmpty ? "" : null;
  if (
    withoutTrailingSlash.length > AI_WORKSPACE_TOOL_LIMITS.maxPathLength ||
    withoutTrailingSlash.startsWith("/") ||
    withoutTrailingSlash.includes("\\") ||
    withoutTrailingSlash.includes("\0")
  ) return null;
  const normalized = withoutTrailingSlash.replace(/^\.\//, "");
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

function pathMatchesPrefix(path: string, prefix: string) {
  return !prefix || path === prefix || path.startsWith(`${prefix}/`);
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

async function sha256(bytes: Uint8Array) {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", owned);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
}

async function readBoundedResponseBody(
  response: Response,
  limit: number,
  signal?: AbortSignal
) {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) {
      throw new TypstPackageInspectionError(
        "typst_package_output_too_large",
        "The Typst package archive exceeds the inspection limit."
      );
    }
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    while (true) {
      checkAbort(signal);
      const { value, done } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        throw new TypstPackageInspectionError(
          "typst_package_output_too_large",
          "The Typst package archive exceeds the inspection limit."
        );
      }
      chunks.push(value);
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function decompressGzip(bytes: Uint8Array, signal?: AbortSignal) {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const stream = new Blob([owned]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      checkAbort(signal);
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > AI_WORKSPACE_TOOL_LIMITS.maxPackageExtractedBytes) {
        throw new TypstPackageInspectionError(
          "typst_package_output_too_large",
          "The Typst package expands beyond the inspection limit."
        );
      }
      chunks.push(value);
    }
  } finally {
    if (signal?.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function decodePackageText(entry: PackageFile) {
  if (entry.text !== undefined) return entry.text;
  if (
    entry.size > AI_WORKSPACE_TOOL_LIMITS.maxPackageTextFileBytes ||
    entry.data.includes(0)
  ) {
    entry.text = null;
    return null;
  }
  try {
    entry.text = new TextDecoder("utf-8", { fatal: true }).decode(entry.data);
  } catch {
    entry.text = null;
  }
  return entry.text;
}

function packageFile(item: ParsedTarFileItem) {
  const path = normalizePackagePath(item.name, false);
  if (!path || item.type !== "file" || item.size < 0 || !Number.isSafeInteger(item.size)) {
    throw new TypstPackageInspectionError(
      "typst_package_archive_invalid",
      "The Typst package archive contains an invalid entry."
    );
  }
  const data = item.data ?? new Uint8Array();
  if (data.byteLength !== item.size) {
    throw new TypstPackageInspectionError(
      "typst_package_archive_invalid",
      "The Typst package archive contains a truncated entry."
    );
  }
  return { kind: "file" as const, path, size: item.size, data, text: undefined };
}

function addParentDirectories(entries: Map<string, PackageEntry>, path: string) {
  const parts = path.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const directory = parts.slice(0, index).join("/");
    const existing = entries.get(directory);
    if (existing?.kind === "file") {
      throw new TypstPackageInspectionError(
        "typst_package_archive_invalid",
        "The Typst package archive contains conflicting paths."
      );
    }
    entries.set(directory, { kind: "directory", path: directory });
  }
}

export async function parseTypstPackageArchive(
  spec: TypstPackageSpec,
  digest: string,
  compressed: Uint8Array,
  signal?: AbortSignal
): Promise<LoadedTypstPackage> {
  const decompressed = await decompressGzip(compressed, signal);
  checkAbort(signal);
  let parsed: ParsedTarFileItem[];
  try {
    parsed = parseTar(decompressed);
  } catch {
    throw new TypstPackageInspectionError(
      "typst_package_archive_invalid",
      "The Typst package archive could not be parsed."
    );
  }
  if (parsed.length === 0 || parsed.length > MAX_PACKAGE_FILES) {
    throw new TypstPackageInspectionError(
      "typst_package_archive_invalid",
      "The Typst package archive has an invalid file count."
    );
  }
  const entries = new Map<string, PackageEntry>();
  for (const item of parsed) {
    checkAbort(signal);
    if (item.type === "directory") continue;
    const file = packageFile(item);
    addParentDirectories(entries, file.path);
    if (entries.has(file.path)) {
      throw new TypstPackageInspectionError(
        "typst_package_archive_invalid",
        "The Typst package archive contains duplicate paths."
      );
    }
    entries.set(file.path, file);
  }
  const manifest = entries.get("typst.toml");
  if (!manifest || manifest.kind !== "file" || decodePackageText(manifest) === null) {
    throw new TypstPackageInspectionError(
      "typst_package_archive_invalid",
      "The Typst package archive does not contain a readable typst.toml."
    );
  }
  return {
    spec,
    digest: `sha256:${digest}`,
    memoryBytes: decompressed.byteLength,
    entries
  };
}

export async function fetchTypstPackage(
  source: TypstPackageSource,
  packageSpec: string,
  signal?: AbortSignal
) {
  const spec = parseTypstPackageSpec(packageSpec);
  if (!spec) {
    throw new TypstPackageInspectionError(
      "typst_package_invalid_spec",
      "Use an exact @local/name:version or @preview/name:version package spec."
    );
  }
  if (source.kind === "preview" && spec.namespace !== "preview") {
    throw new TypstPackageInspectionError(
      "typst_package_not_found",
      `Typst package ${spec.canonical} is not available from the configured registry.`
    );
  }
  const base = source.baseUrl.replace(/\/$/, "");
  const url = source.kind === "preview"
    ? new URL(
        `${base}/preview/${encodeURIComponent(spec.name)}-${encodeURIComponent(spec.version)}.tar.gz`
      )
    : new URL(
        `${base}/${encodeURIComponent(spec.namespace)}/${encodeURIComponent(spec.name)}/${encodeURIComponent(spec.version)}`
      );
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: source.kind === "toss" && source.withCredentials
        ? "include"
        : "omit",
      cache: "force-cache",
      signal
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new TypstPackageInspectionError(
      "typst_package_unavailable",
      "The Typst package archive could not be fetched."
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new TypstPackageInspectionError(
      "typst_package_access_denied",
      "The current session cannot read Typst package archives."
    );
  }
  if (response.status === 404) {
    throw new TypstPackageInspectionError(
      "typst_package_not_found",
      `Typst package ${spec.canonical} was not found.`
    );
  }
  if (!response.ok) {
    throw new TypstPackageInspectionError(
      "typst_package_unavailable",
      `Typst package ${spec.canonical} could not be loaded (HTTP ${response.status}).`
    );
  }
  const expectedDigest = source.kind === "toss"
    ? response.headers.get(SHA256_HEADER)?.toLowerCase() ?? ""
    : null;
  if (expectedDigest !== null && !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new TypstPackageInspectionError(
      "typst_package_archive_invalid",
      "The Typst package response is missing its verified digest."
    );
  }
  const contentLength = response.headers.get("content-length");
  const declaredSize = contentLength === null ? null : Number(contentLength);
  if (declaredSize !== null && (
    !Number.isSafeInteger(declaredSize) ||
    declaredSize < 0 ||
    declaredSize > AI_WORKSPACE_TOOL_LIMITS.maxPackageArchiveBytes
  )) {
    throw new TypstPackageInspectionError(
      "typst_package_output_too_large",
      "The Typst package archive exceeds the inspection limit."
    );
  }
  let compressed: Uint8Array;
  try {
    compressed = await readBoundedResponseBody(
      response,
      AI_WORKSPACE_TOOL_LIMITS.maxPackageArchiveBytes,
      signal
    );
  } catch (error) {
    if (signal?.aborted || error instanceof TypstPackageInspectionError) throw error;
    throw new TypstPackageInspectionError(
      "typst_package_unavailable",
      "The Typst package archive could not be read."
    );
  }
  if (compressed.byteLength === 0) {
    throw new TypstPackageInspectionError(
      "typst_package_archive_invalid",
      "The Typst package archive is empty."
    );
  }
  checkAbort(signal);
  const actualDigest = await sha256(compressed);
  if (expectedDigest !== null && actualDigest !== expectedDigest) {
    throw new TypstPackageInspectionError(
      "typst_package_archive_invalid",
      "The Typst package archive digest does not match the server contract."
    );
  }
  return parseTypstPackageArchive(spec, actualDigest, compressed, signal);
}

function packageIdentity(pkg: LoadedTypstPackage) {
  return {
    package_spec: pkg.spec.canonical,
    package_digest: pkg.digest
  };
}

export function listTypstPackageFiles(
  pkg: LoadedTypstPackage,
  args: AiListTypstPackageFilesArguments
): AiListTypstPackageFilesResult {
  const prefix = normalizePackagePath(args.path_prefix ?? "", true);
  if (prefix === null) {
    throw new TypstPackageInspectionError(
      "typst_package_invalid_path",
      "The package path prefix is invalid."
    );
  }
  const offset = args.offset ?? 0;
  const limit = args.limit ?? DEFAULT_LIST_LIMIT;
  const entries = [...pkg.entries.values()]
    .filter((entry) => pathMatchesPrefix(entry.path, prefix))
    .sort((left, right) => left.path.localeCompare(right.path));
  const page = entries.slice(offset, offset + limit).map((entry) => ({
    path: entry.path,
    kind: entry.kind === "directory"
      ? "directory" as const
      : decodePackageText(entry) === null
        ? "asset" as const
        : "text" as const,
    size_bytes: entry.kind === "file" ? entry.size : null
  }));
  const nextOffset = offset + page.length;
  return {
    ...packageIdentity(pkg),
    manifest_path: "typst.toml",
    entries: page,
    offset,
    total: entries.length,
    next_offset: nextOffset < entries.length ? nextOffset : null
  };
}

function numberedRange(text: string, startLine: number, requestedEndLine?: number) {
  const lines = text.split("\n");
  if (startLine > lines.length) {
    throw new TypstPackageInspectionError(
      "workspace_invalid_arguments",
      "The requested start line is past the end of the package file."
    );
  }
  const endLine = requestedEndLine ?? Math.min(
    lines.length,
    startLine + AI_WORKSPACE_TOOL_LIMITS.maxReadLines - 1
  );
  if (
    endLine < startLine ||
    endLine - startLine + 1 > AI_WORKSPACE_TOOL_LIMITS.maxReadLines
  ) {
    throw new TypstPackageInspectionError(
      "workspace_invalid_arguments",
      "The requested package line range is invalid or too large."
    );
  }
  const boundedEnd = Math.min(endLine, lines.length);
  const width = String(boundedEnd).length;
  const numbered: string[] = [];
  let characters = 0;
  let actualEnd = startLine;
  let truncated = false;
  for (let lineNumber = startLine; lineNumber <= boundedEnd; lineNumber += 1) {
    const rendered = `${String(lineNumber).padStart(width, " ")} | ${lines[lineNumber - 1]}`;
    const separator = numbered.length === 0 ? 0 : 1;
    const remaining = AI_WORKSPACE_TOOL_LIMITS.maxReadCharacters - characters - separator;
    if (rendered.length > remaining) {
      if (remaining > 0) numbered.push(rendered.slice(0, remaining));
      actualEnd = lineNumber;
      truncated = true;
      break;
    }
    numbered.push(rendered);
    characters += separator + rendered.length;
    actualEnd = lineNumber;
  }
  return {
    start_line: startLine,
    end_line: actualEnd,
    total_lines: lines.length,
    has_more: truncated || actualEnd < lines.length,
    content_truncated: truncated,
    numbered_content: numbered.join("\n")
  };
}

export function readTypstPackageFile(
  pkg: LoadedTypstPackage,
  args: AiReadTypstPackageFileArguments
): AiReadTypstPackageFileResult {
  const path = normalizePackagePath(args.path, false);
  if (!path) {
    throw new TypstPackageInspectionError(
      "typst_package_invalid_path",
      "The package file path is invalid."
    );
  }
  const entry = pkg.entries.get(path);
  if (!entry || entry.kind !== "file") {
    throw new TypstPackageInspectionError(
      "typst_package_file_not_found",
      "The requested package file does not exist."
    );
  }
  const text = decodePackageText(entry);
  if (text === null) {
    throw new TypstPackageInspectionError(
      "typst_package_file_not_text",
      "The requested package file is binary or exceeds the text inspection limit."
    );
  }
  return {
    ...packageIdentity(pkg),
    path,
    ...numberedRange(text, args.start_line ?? 1, args.end_line)
  };
}

function searchExcerpt(lineNumber: number, line: string, matchIndex: number) {
  const prefix = `${lineNumber} | `;
  const budget = Math.max(1, AI_WORKSPACE_TOOL_LIMITS.maxSearchExcerptLength - prefix.length);
  if (line.length <= budget) return `${prefix}${line}`;
  const start = Math.max(0, Math.min(
    matchIndex - Math.floor(budget / 3),
    line.length - budget + 2
  ));
  const leading = start > 0 ? "…" : "";
  const available = budget - leading.length - 1;
  const body = line.slice(start, start + available);
  const trailing = start + available < line.length ? "…" : "";
  return `${prefix}${leading}${body}${trailing}`.slice(
    0,
    AI_WORKSPACE_TOOL_LIMITS.maxSearchExcerptLength
  );
}

export function searchTypstPackageText(
  pkg: LoadedTypstPackage,
  args: AiSearchTypstPackageTextArguments,
  signal?: AbortSignal
): AiSearchTypstPackageTextResult {
  const prefix = normalizePackagePath(args.path_prefix ?? "", true);
  if (prefix === null) {
    throw new TypstPackageInspectionError(
      "typst_package_invalid_path",
      "The package path prefix is invalid."
    );
  }
  const caseSensitive = args.case_sensitive ?? false;
  const needle = caseSensitive ? args.query : args.query.toLowerCase();
  const maxResults = args.max_results ?? DEFAULT_SEARCH_RESULTS;
  const matches: AiSearchTypstPackageTextResult["matches"] = [];
  let filesSearched = 0;
  let charactersSearched = 0;
  let truncated = false;
  const entries = [...pkg.entries.values()]
    .filter((entry): entry is PackageFile => (
      entry.kind === "file" && pathMatchesPrefix(entry.path, prefix)
    ))
    .sort((left, right) => left.path.localeCompare(right.path));
  search: for (const entry of entries) {
    checkAbort(signal);
    const text = decodePackageText(entry);
    if (text === null) continue;
    if (charactersSearched + text.length > AI_WORKSPACE_TOOL_LIMITS.maxPackageSearchCharacters) {
      truncated = true;
      break;
    }
    charactersSearched += text.length;
    filesSearched += 1;
    const lines = text.split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      const haystack = caseSensitive ? line : line.toLowerCase();
      let fromIndex = 0;
      while (fromIndex <= haystack.length) {
        const matchIndex = haystack.indexOf(needle, fromIndex);
        if (matchIndex < 0) break;
        if (matches.length >= maxResults) {
          truncated = true;
          break search;
        }
        matches.push({
          path: entry.path,
          line: lineIndex + 1,
          column: matchIndex + 1,
          numbered_excerpt: searchExcerpt(lineIndex + 1, line, matchIndex)
        });
        fromIndex = matchIndex + Math.max(needle.length, 1);
      }
    }
  }
  return {
    ...packageIdentity(pkg),
    query: args.query,
    case_sensitive: caseSensitive,
    files_searched: filesSearched,
    matches,
    truncated
  };
}
