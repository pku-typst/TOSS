export const AI_WORKSPACE_TOOL_NAMES = [
  "list_project_files",
  "read_project_file",
  "search_project_text",
  "inspect_compilation",
  "list_typst_package_files",
  "read_typst_package_file",
  "search_typst_package_text",
  "apply_patch",
  "write_file"
] as const;

export type AiWorkspaceToolName = (typeof AI_WORKSPACE_TOOL_NAMES)[number];
export type AiTypstPackageToolName = Extract<
  AiWorkspaceToolName,
  | "list_typst_package_files"
  | "read_typst_package_file"
  | "search_typst_package_text"
>;
export type AiWorkspaceProjectType = "typst" | "latex";
export type AiWorkspaceMode = "live" | "revision";

export const AI_WORKSPACE_TOOL_LIMITS = {
  maxPathLength: 1_024,
  maxListEntries: 200,
  maxReadLines: 400,
  maxReadCharacters: 65_536,
  maxSearchQueryLength: 256,
  maxSearchMatches: 100,
  maxSearchExcerptLength: 1_024,
  maxPackageSpecLength: 192,
  maxPackageArchiveBytes: 64 * 1024 * 1024,
  maxPackageExtractedBytes: 96 * 1024 * 1024,
  maxPackageTextFileBytes: 1024 * 1024,
  maxPackageSearchCharacters: 2_000_000,
  maxPatchCharacters: 131_072,
  maxPatchHunks: 64,
  maxPatchChangedLines: 2_000,
  maxWriteFileCharacters: 65_536,
  maxCompileErrors: 20,
  maxCompileDiagnostics: 100,
  maxCompileMessageLength: 2_048,
  maxToolCallsPerTurn: 32,
  maxPendingToolCalls: 8
} as const;

export type AiWorkspaceCapabilities = {
  project_type: AiWorkspaceProjectType;
  mode: AiWorkspaceMode;
  tools: AiWorkspaceToolName[];
};

export const AI_WORKSPACE_CONTEXT_SCHEMA = 1 as const;

export type AiWorkspaceContextSnapshot = {
  schema: typeof AI_WORKSPACE_CONTEXT_SCHEMA;
  project_name: string;
  project_type: AiWorkspaceProjectType;
  mode: AiWorkspaceMode;
  entry_file_path: string;
  active_path: string;
  access: "read" | "edit";
  workspace_state: "ready" | "syncing" | "offline";
  active_document_state: "ready" | "unavailable";
  files: {
    total: number;
    text: number;
    assets: number;
  };
  compilation: {
    state: "idle" | "running" | "succeeded" | "failed" | "unavailable";
    errors: number;
    warnings: number;
  };
  pending_edit_review: boolean;
  last_edit_review: {
    review_id: string;
    decision: AiWorkspaceEditReviewDecision;
  } | null;
};

export type AiListProjectFilesArguments = {
  path_prefix?: string;
  offset?: number;
  limit?: number;
};

export type AiReadProjectFileArguments = {
  path: string;
  start_line?: number;
  end_line?: number;
};

export type AiSearchProjectTextArguments = {
  query: string;
  path_prefix?: string;
  case_sensitive?: boolean;
  max_results?: number;
};

export type AiInspectCompilationArguments = Record<string, never>;

export type AiListTypstPackageFilesArguments = {
  package_spec: string;
  path_prefix?: string;
  offset?: number;
  limit?: number;
};

export type AiReadTypstPackageFileArguments = {
  package_spec: string;
  path: string;
  start_line?: number;
  end_line?: number;
};

export type AiSearchTypstPackageTextArguments = {
  package_spec: string;
  query: string;
  path_prefix?: string;
  case_sensitive?: boolean;
  max_results?: number;
};

export type AiApplyPatchArguments = {
  path: string;
  base_snapshot: string;
  patch: string;
};

export type AiWriteFileArguments = {
  path: string;
  base_snapshot: string;
  content: string;
};

export type AiWorkspaceToolRequest =
  | { tool: "list_project_files"; arguments: AiListProjectFilesArguments }
  | { tool: "read_project_file"; arguments: AiReadProjectFileArguments }
  | { tool: "search_project_text"; arguments: AiSearchProjectTextArguments }
  | { tool: "inspect_compilation"; arguments: AiInspectCompilationArguments }
  | { tool: "list_typst_package_files"; arguments: AiListTypstPackageFilesArguments }
  | { tool: "read_typst_package_file"; arguments: AiReadTypstPackageFileArguments }
  | { tool: "search_typst_package_text"; arguments: AiSearchTypstPackageTextArguments }
  | { tool: "apply_patch"; arguments: AiApplyPatchArguments }
  | { tool: "write_file"; arguments: AiWriteFileArguments };

export type AiTypstPackageToolRequest = Extract<
  AiWorkspaceToolRequest,
  { tool: AiTypstPackageToolName }
>;

export type AiListProjectFilesResult = {
  project_type: AiWorkspaceProjectType;
  mode: AiWorkspaceMode;
  entry_file_path: string;
  active_path: string;
  entries: Array<{
    path: string;
    kind: "directory" | "text" | "asset";
  }>;
  offset: number;
  total: number;
  next_offset: number | null;
};

export type AiReadProjectFileResult = {
  path: string;
  snapshot_id: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  has_more: boolean;
  content_truncated: boolean;
  numbered_content: string;
};

export type AiSearchProjectTextResult = {
  query: string;
  case_sensitive: boolean;
  files_searched: number;
  matches: Array<{
    path: string;
    line: number;
    column: number;
    numbered_excerpt: string;
  }>;
  truncated: boolean;
};

export type AiInspectCompilationResult = {
  project_type: AiWorkspaceProjectType;
  entry_file_path: string;
  active_path: string;
  state: AiWorkspaceContextSnapshot["compilation"]["state"];
  diagnostics_current: boolean;
  errors: string[];
  diagnostics: AiPatchCompileDiagnostic[];
  truncated: boolean;
};

export type AiListTypstPackageFilesResult = {
  package_spec: string;
  package_digest: string;
  manifest_path: "typst.toml";
  entries: Array<{
    path: string;
    kind: "directory" | "text" | "asset";
    size_bytes: number | null;
  }>;
  offset: number;
  total: number;
  next_offset: number | null;
};

export type AiReadTypstPackageFileResult = {
  package_spec: string;
  package_digest: string;
  path: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  has_more: boolean;
  content_truncated: boolean;
  numbered_content: string;
};

export type AiSearchTypstPackageTextResult = {
  package_spec: string;
  package_digest: string;
  query: string;
  case_sensitive: boolean;
  files_searched: number;
  matches: Array<{
    path: string;
    line: number;
    column: number;
    numbered_excerpt: string;
  }>;
  truncated: boolean;
};

export type AiEditResult = {
  path: string;
  base_snapshot: string;
  status: "review_pending" | "compile_failed";
  review_id: string | null;
  verification: AiPatchCompileVerification;
};

export type AiWorkspaceEditReviewDecision =
  | "accepted"
  | "rejected"
  | "stale"
  | "cancelled";

export type AiWorkspaceEditReviewOutcome = {
  reviewId: string;
  decision: AiWorkspaceEditReviewDecision;
  decidedAt: number;
};

export type AiApplyPatchResult = AiEditResult;
export type AiWriteFileResult = AiEditResult;

export type AiPatchCompileDiagnostic = {
  severity: "error" | "warning" | "info";
  message: string;
  path: string | null;
  line: number | null;
  column: number | null;
};

export type AiPatchCompileVerification = {
  status: "passed" | "failed";
  errors: string[];
  diagnostics: AiPatchCompileDiagnostic[];
  truncated: boolean;
};

export type AiWorkspaceToolResult =
  | AiListProjectFilesResult
  | AiReadProjectFileResult
  | AiSearchProjectTextResult
  | AiInspectCompilationResult
  | AiListTypstPackageFilesResult
  | AiReadTypstPackageFileResult
  | AiSearchTypstPackageTextResult
  | AiApplyPatchResult
  | AiWriteFileResult;

export const AI_WORKSPACE_TOOL_ERROR_CODES = [
  "workspace_invalid_arguments",
  "workspace_invalid_path",
  "workspace_scope_changed",
  "workspace_file_not_found",
  "workspace_file_not_text",
  "workspace_file_unavailable",
  "workspace_document_not_active",
  "workspace_permission_denied",
  "workspace_snapshot_stale",
  "workspace_patch_invalid",
  "workspace_full_read_required",
  "workspace_candidate_compile_unavailable",
  "workspace_review_in_progress",
  "workspace_request_cancelled",
  "workspace_tool_not_available",
  "workspace_tool_budget_exceeded",
  "workspace_tool_concurrency_exceeded",
  "workspace_tool_call_duplicate",
  "workspace_tool_internal_error",
  "typst_package_invalid_spec",
  "typst_package_not_found",
  "typst_package_access_denied",
  "typst_package_unavailable",
  "typst_package_archive_invalid",
  "typst_package_invalid_path",
  "typst_package_file_not_found",
  "typst_package_file_not_text",
  "typst_package_output_too_large",
  "typst_package_internal_error"
] as const;

export type AiWorkspaceToolErrorCode = (typeof AI_WORKSPACE_TOOL_ERROR_CODES)[number];

export type AiWorkspaceToolExecution =
  | { outcome: "success"; result: AiWorkspaceToolResult }
  | {
      outcome: "error";
      error: {
        code: AiWorkspaceToolErrorCode;
        message: string;
      };
    };

export interface AiWorkspaceToolPort {
  readonly capabilities: AiWorkspaceCapabilities;
  getContextSnapshot(): AiWorkspaceContextSnapshot;
  dispose(): void;
  execute(
    request: AiWorkspaceToolRequest,
    signal?: AbortSignal
  ): Promise<AiWorkspaceToolExecution>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = []
) {
  const actual = Object.keys(value);
  return required.every((key) => actual.includes(key)) && actual.every((key) => allowed.includes(key));
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    (allowEmpty || value.length > 0)
  );
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

export function isAiWorkspaceToolName(value: unknown): value is AiWorkspaceToolName {
  return AI_WORKSPACE_TOOL_NAMES.some((name) => name === value);
}

export function isAiTypstPackageToolName(value: unknown): value is AiTypstPackageToolName {
  return value === "list_typst_package_files" ||
    value === "read_typst_package_file" ||
    value === "search_typst_package_text";
}

export function isAiTypstPackageToolRequest(
  request: AiWorkspaceToolRequest
): request is AiTypstPackageToolRequest {
  return isAiTypstPackageToolName(request.tool);
}

export function isAiWorkspaceToolErrorCode(value: unknown): value is AiWorkspaceToolErrorCode {
  return AI_WORKSPACE_TOOL_ERROR_CODES.some((code) => code === value);
}

export function isAiWorkspaceCapabilities(value: unknown): value is AiWorkspaceCapabilities {
  if (!isRecord(value) || !hasExactKeys(value, ["project_type", "mode", "tools"])) return false;
  if (value.project_type !== "typst" && value.project_type !== "latex") return false;
  if (value.mode !== "live" && value.mode !== "revision") return false;
  if (!Array.isArray(value.tools) || value.tools.length > AI_WORKSPACE_TOOL_NAMES.length) return false;
  if (!value.tools.every(isAiWorkspaceToolName)) return false;
  return new Set(value.tools).size === value.tools.length;
}

export function isAiWorkspaceContextSnapshot(
  value: unknown
): value is AiWorkspaceContextSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schema",
    "project_name",
    "project_type",
    "mode",
    "entry_file_path",
    "active_path",
    "access",
    "workspace_state",
    "active_document_state",
    "files",
    "compilation",
    "pending_edit_review",
    "last_edit_review"
  ])) return false;
  if (
    value.schema !== AI_WORKSPACE_CONTEXT_SCHEMA ||
    !isBoundedString(value.project_name, 256) ||
    (value.project_type !== "typst" && value.project_type !== "latex") ||
    (value.mode !== "live" && value.mode !== "revision") ||
    !isBoundedString(value.entry_file_path, AI_WORKSPACE_TOOL_LIMITS.maxPathLength) ||
    !isBoundedString(value.active_path, AI_WORKSPACE_TOOL_LIMITS.maxPathLength) ||
    (value.access !== "read" && value.access !== "edit") ||
    !["ready", "syncing", "offline"].includes(value.workspace_state as string) ||
    (value.active_document_state !== "ready" && value.active_document_state !== "unavailable") ||
    typeof value.pending_edit_review !== "boolean" ||
    !(
      value.last_edit_review === null ||
      (
        isRecord(value.last_edit_review) &&
        hasExactKeys(value.last_edit_review, ["review_id", "decision"]) &&
        isBoundedString(value.last_edit_review.review_id, 128) &&
        ["accepted", "rejected", "stale", "cancelled"].includes(
          value.last_edit_review.decision as string
        )
      )
    )
  ) return false;
  if (!isRecord(value.files) || !hasExactKeys(value.files, ["total", "text", "assets"])) {
    return false;
  }
  if (
    !isSafeNonNegativeInteger(value.files.total) ||
    !isSafeNonNegativeInteger(value.files.text) ||
    !isSafeNonNegativeInteger(value.files.assets) ||
    value.files.text + value.files.assets > value.files.total
  ) return false;
  if (
    !isRecord(value.compilation) ||
    !hasExactKeys(value.compilation, ["state", "errors", "warnings"]) ||
    !["idle", "running", "succeeded", "failed", "unavailable"].includes(
      value.compilation.state as string
    ) ||
    !isSafeNonNegativeInteger(value.compilation.errors) ||
    !isSafeNonNegativeInteger(value.compilation.warnings)
  ) return false;
  return true;
}

export function isAiWorkspaceToolArguments(
  tool: AiWorkspaceToolName,
  value: unknown
): boolean {
  if (!isRecord(value)) return false;
  if (tool === "inspect_compilation") return hasExactKeys(value, []);
  if (tool === "list_project_files") {
    if (!hasOnlyKeys(value, ["path_prefix", "offset", "limit"])) return false;
    return (
      (value.path_prefix === undefined ||
        isBoundedString(value.path_prefix, AI_WORKSPACE_TOOL_LIMITS.maxPathLength, true)) &&
      (value.offset === undefined || isSafeNonNegativeInteger(value.offset)) &&
      (value.limit === undefined ||
        (isSafePositiveInteger(value.limit) && value.limit <= AI_WORKSPACE_TOOL_LIMITS.maxListEntries))
    );
  }
  if (tool === "read_project_file") {
    if (!hasOnlyKeys(value, ["path", "start_line", "end_line"], ["path"])) return false;
    return (
      isBoundedString(value.path, AI_WORKSPACE_TOOL_LIMITS.maxPathLength) &&
      (value.start_line === undefined || isSafePositiveInteger(value.start_line)) &&
      (value.end_line === undefined || isSafePositiveInteger(value.end_line))
    );
  }
  if (tool === "list_typst_package_files") {
    if (!hasOnlyKeys(
      value,
      ["package_spec", "path_prefix", "offset", "limit"],
      ["package_spec"]
    )) return false;
    return (
      isBoundedString(value.package_spec, AI_WORKSPACE_TOOL_LIMITS.maxPackageSpecLength) &&
      (value.path_prefix === undefined ||
        isBoundedString(value.path_prefix, AI_WORKSPACE_TOOL_LIMITS.maxPathLength, true)) &&
      (value.offset === undefined || isSafeNonNegativeInteger(value.offset)) &&
      (value.limit === undefined ||
        (isSafePositiveInteger(value.limit) &&
          value.limit <= AI_WORKSPACE_TOOL_LIMITS.maxListEntries))
    );
  }
  if (tool === "read_typst_package_file") {
    if (!hasOnlyKeys(
      value,
      ["package_spec", "path", "start_line", "end_line"],
      ["package_spec", "path"]
    )) return false;
    return (
      isBoundedString(value.package_spec, AI_WORKSPACE_TOOL_LIMITS.maxPackageSpecLength) &&
      isBoundedString(value.path, AI_WORKSPACE_TOOL_LIMITS.maxPathLength) &&
      (value.start_line === undefined || isSafePositiveInteger(value.start_line)) &&
      (value.end_line === undefined || isSafePositiveInteger(value.end_line))
    );
  }
  if (tool === "search_typst_package_text") {
    if (!hasOnlyKeys(
      value,
      ["package_spec", "query", "path_prefix", "case_sensitive", "max_results"],
      ["package_spec", "query"]
    )) return false;
    return (
      isBoundedString(value.package_spec, AI_WORKSPACE_TOOL_LIMITS.maxPackageSpecLength) &&
      isBoundedString(value.query, AI_WORKSPACE_TOOL_LIMITS.maxSearchQueryLength) &&
      (value.path_prefix === undefined ||
        isBoundedString(value.path_prefix, AI_WORKSPACE_TOOL_LIMITS.maxPathLength, true)) &&
      (value.case_sensitive === undefined || typeof value.case_sensitive === "boolean") &&
      (value.max_results === undefined ||
        (isSafePositiveInteger(value.max_results) &&
          value.max_results <= AI_WORKSPACE_TOOL_LIMITS.maxSearchMatches))
    );
  }
  if (tool === "apply_patch") {
    if (!hasExactKeys(value, ["path", "base_snapshot", "patch"])) return false;
    return (
      isBoundedString(value.path, AI_WORKSPACE_TOOL_LIMITS.maxPathLength) &&
      isBoundedString(value.base_snapshot, 128) &&
      isBoundedString(value.patch, AI_WORKSPACE_TOOL_LIMITS.maxPatchCharacters)
    );
  }
  if (tool === "write_file") {
    if (!hasExactKeys(value, ["path", "base_snapshot", "content"])) return false;
    return (
      isBoundedString(value.path, AI_WORKSPACE_TOOL_LIMITS.maxPathLength) &&
      isBoundedString(value.base_snapshot, 128) &&
      isBoundedString(value.content, AI_WORKSPACE_TOOL_LIMITS.maxWriteFileCharacters, true)
    );
  }
  if (!hasOnlyKeys(
    value,
    ["query", "path_prefix", "case_sensitive", "max_results"],
    ["query"]
  )) return false;
  return (
    isBoundedString(value.query, AI_WORKSPACE_TOOL_LIMITS.maxSearchQueryLength) &&
    (value.path_prefix === undefined ||
      isBoundedString(value.path_prefix, AI_WORKSPACE_TOOL_LIMITS.maxPathLength, true)) &&
    (value.case_sensitive === undefined || typeof value.case_sensitive === "boolean") &&
    (value.max_results === undefined ||
      (isSafePositiveInteger(value.max_results) &&
        value.max_results <= AI_WORKSPACE_TOOL_LIMITS.maxSearchMatches))
  );
}

function isListResult(value: unknown): value is AiListProjectFilesResult {
  if (!isRecord(value) || !hasExactKeys(value, [
    "project_type",
    "mode",
    "entry_file_path",
    "active_path",
    "entries",
    "offset",
    "total",
    "next_offset"
  ])) return false;
  return (
    (value.project_type === "typst" || value.project_type === "latex") &&
    (value.mode === "live" || value.mode === "revision") &&
    isBoundedString(value.entry_file_path, AI_WORKSPACE_TOOL_LIMITS.maxPathLength) &&
    isBoundedString(value.active_path, AI_WORKSPACE_TOOL_LIMITS.maxPathLength) &&
    Array.isArray(value.entries) &&
    value.entries.length <= AI_WORKSPACE_TOOL_LIMITS.maxListEntries &&
    value.entries.every((entry) => (
      isRecord(entry) &&
      hasExactKeys(entry, ["path", "kind"]) &&
      isBoundedString(entry.path, AI_WORKSPACE_TOOL_LIMITS.maxPathLength) &&
      (entry.kind === "directory" || entry.kind === "text" || entry.kind === "asset")
    )) &&
    isSafeNonNegativeInteger(value.offset) &&
    isSafeNonNegativeInteger(value.total) &&
    (value.next_offset === null || isSafeNonNegativeInteger(value.next_offset))
  );
}

function isReadResult(value: unknown): value is AiReadProjectFileResult {
  if (!isRecord(value) || !hasExactKeys(value, [
    "path",
    "snapshot_id",
    "start_line",
    "end_line",
    "total_lines",
    "has_more",
    "content_truncated",
    "numbered_content"
  ])) return false;
  return (
    isBoundedString(value.path, AI_WORKSPACE_TOOL_LIMITS.maxPathLength) &&
    isBoundedString(value.snapshot_id, 128) &&
    isSafePositiveInteger(value.start_line) &&
    isSafePositiveInteger(value.end_line) &&
    isSafePositiveInteger(value.total_lines) &&
    typeof value.has_more === "boolean" &&
    typeof value.content_truncated === "boolean" &&
    isBoundedString(value.numbered_content, AI_WORKSPACE_TOOL_LIMITS.maxReadCharacters, true)
  );
}

function isSearchResult(value: unknown): value is AiSearchProjectTextResult {
  if (!isRecord(value) || !hasExactKeys(value, [
    "query",
    "case_sensitive",
    "files_searched",
    "matches",
    "truncated"
  ])) return false;
  return (
    isBoundedString(value.query, AI_WORKSPACE_TOOL_LIMITS.maxSearchQueryLength) &&
    typeof value.case_sensitive === "boolean" &&
    isSafeNonNegativeInteger(value.files_searched) &&
    Array.isArray(value.matches) &&
    value.matches.length <= AI_WORKSPACE_TOOL_LIMITS.maxSearchMatches &&
    value.matches.every((match) => (
      isRecord(match) &&
      hasExactKeys(match, ["path", "line", "column", "numbered_excerpt"]) &&
      isBoundedString(match.path, AI_WORKSPACE_TOOL_LIMITS.maxPathLength) &&
      isSafePositiveInteger(match.line) &&
      isSafePositiveInteger(match.column) &&
      isBoundedString(
        match.numbered_excerpt,
        AI_WORKSPACE_TOOL_LIMITS.maxSearchExcerptLength,
        true
      )
    )) &&
    typeof value.truncated === "boolean"
  );
}

function isCompileDiagnostic(value: unknown): value is AiPatchCompileDiagnostic {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["severity", "message", "path", "line", "column"]) &&
    (value.severity === "error" || value.severity === "warning" || value.severity === "info") &&
    isBoundedString(value.message, AI_WORKSPACE_TOOL_LIMITS.maxCompileMessageLength) &&
    (
      value.path === null ||
      isBoundedString(value.path, AI_WORKSPACE_TOOL_LIMITS.maxPathLength)
    ) &&
    (value.line === null || isSafePositiveInteger(value.line)) &&
    (value.column === null || isSafePositiveInteger(value.column))
  );
}

function isCompilationResult(value: unknown): value is AiInspectCompilationResult {
  if (!isRecord(value) || !hasExactKeys(value, [
    "project_type",
    "entry_file_path",
    "active_path",
    "state",
    "diagnostics_current",
    "errors",
    "diagnostics",
    "truncated"
  ])) return false;
  return (
    (value.project_type === "typst" || value.project_type === "latex") &&
    isBoundedString(value.entry_file_path, AI_WORKSPACE_TOOL_LIMITS.maxPathLength) &&
    isBoundedString(value.active_path, AI_WORKSPACE_TOOL_LIMITS.maxPathLength) &&
    ["idle", "running", "succeeded", "failed", "unavailable"].includes(
      value.state as string
    ) &&
    typeof value.diagnostics_current === "boolean" &&
    (!value.diagnostics_current || value.state === "succeeded" || value.state === "failed") &&
    Array.isArray(value.errors) &&
    value.errors.length <= AI_WORKSPACE_TOOL_LIMITS.maxCompileErrors &&
    value.errors.every((error) =>
      isBoundedString(error, AI_WORKSPACE_TOOL_LIMITS.maxCompileMessageLength)
    ) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.length <= AI_WORKSPACE_TOOL_LIMITS.maxCompileDiagnostics &&
    value.diagnostics.every(isCompileDiagnostic) &&
    typeof value.truncated === "boolean"
  );
}

function isPackageIdentity(value: Record<string, unknown>) {
  return (
    isBoundedString(value.package_spec, AI_WORKSPACE_TOOL_LIMITS.maxPackageSpecLength) &&
    typeof value.package_digest === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(value.package_digest)
  );
}

function isPackageListResult(value: unknown): value is AiListTypstPackageFilesResult {
  if (!isRecord(value) || !hasExactKeys(value, [
    "package_spec",
    "package_digest",
    "manifest_path",
    "entries",
    "offset",
    "total",
    "next_offset"
  ])) return false;
  return (
    isPackageIdentity(value) &&
    value.manifest_path === "typst.toml" &&
    Array.isArray(value.entries) &&
    value.entries.length <= AI_WORKSPACE_TOOL_LIMITS.maxListEntries &&
    value.entries.every((entry) => (
      isRecord(entry) &&
      hasExactKeys(entry, ["path", "kind", "size_bytes"]) &&
      isBoundedString(entry.path, AI_WORKSPACE_TOOL_LIMITS.maxPathLength) &&
      (entry.kind === "directory" || entry.kind === "text" || entry.kind === "asset") &&
      (entry.size_bytes === null || isSafeNonNegativeInteger(entry.size_bytes))
    )) &&
    isSafeNonNegativeInteger(value.offset) &&
    isSafeNonNegativeInteger(value.total) &&
    (value.next_offset === null || isSafeNonNegativeInteger(value.next_offset))
  );
}

function isPackageReadResult(value: unknown): value is AiReadTypstPackageFileResult {
  if (!isRecord(value) || !hasExactKeys(value, [
    "package_spec",
    "package_digest",
    "path",
    "start_line",
    "end_line",
    "total_lines",
    "has_more",
    "content_truncated",
    "numbered_content"
  ])) return false;
  return (
    isPackageIdentity(value) &&
    isBoundedString(value.path, AI_WORKSPACE_TOOL_LIMITS.maxPathLength) &&
    isSafePositiveInteger(value.start_line) &&
    isSafePositiveInteger(value.end_line) &&
    isSafePositiveInteger(value.total_lines) &&
    typeof value.has_more === "boolean" &&
    typeof value.content_truncated === "boolean" &&
    isBoundedString(value.numbered_content, AI_WORKSPACE_TOOL_LIMITS.maxReadCharacters, true)
  );
}

function isPackageSearchResult(value: unknown): value is AiSearchTypstPackageTextResult {
  if (!isRecord(value) || !hasExactKeys(value, [
    "package_spec",
    "package_digest",
    "query",
    "case_sensitive",
    "files_searched",
    "matches",
    "truncated"
  ])) return false;
  return (
    isPackageIdentity(value) &&
    isBoundedString(value.query, AI_WORKSPACE_TOOL_LIMITS.maxSearchQueryLength) &&
    typeof value.case_sensitive === "boolean" &&
    isSafeNonNegativeInteger(value.files_searched) &&
    Array.isArray(value.matches) &&
    value.matches.length <= AI_WORKSPACE_TOOL_LIMITS.maxSearchMatches &&
    value.matches.every((match) => (
      isRecord(match) &&
      hasExactKeys(match, ["path", "line", "column", "numbered_excerpt"]) &&
      isBoundedString(match.path, AI_WORKSPACE_TOOL_LIMITS.maxPathLength) &&
      isSafePositiveInteger(match.line) &&
      isSafePositiveInteger(match.column) &&
      isBoundedString(
        match.numbered_excerpt,
        AI_WORKSPACE_TOOL_LIMITS.maxSearchExcerptLength,
        true
      )
    )) &&
    typeof value.truncated === "boolean"
  );
}

function isEditResult(value: unknown): value is AiEditResult {
  if (!isRecord(value) || !hasExactKeys(value, [
    "path",
    "base_snapshot",
    "status",
    "review_id",
    "verification"
  ])) return false;
  const verification = value.verification;
  return (
    isBoundedString(value.path, AI_WORKSPACE_TOOL_LIMITS.maxPathLength) &&
    isBoundedString(value.base_snapshot, 128) &&
    (value.status === "review_pending" || value.status === "compile_failed") &&
    (
      value.status === "review_pending"
        ? isBoundedString(value.review_id, 128)
        : value.review_id === null
    ) &&
    isRecord(verification) &&
    hasExactKeys(verification, ["status", "errors", "diagnostics", "truncated"]) &&
    (verification.status === "passed" || verification.status === "failed") &&
    (
      (value.status === "review_pending" && verification.status === "passed") ||
      (value.status === "compile_failed" && verification.status === "failed")
    ) &&
    Array.isArray(verification.errors) &&
    verification.errors.length <= AI_WORKSPACE_TOOL_LIMITS.maxCompileErrors &&
    verification.errors.every((error) =>
      isBoundedString(error, AI_WORKSPACE_TOOL_LIMITS.maxCompileMessageLength)
    ) &&
    Array.isArray(verification.diagnostics) &&
    verification.diagnostics.length <= AI_WORKSPACE_TOOL_LIMITS.maxCompileDiagnostics &&
    verification.diagnostics.every(isCompileDiagnostic) &&
    typeof verification.truncated === "boolean"
  );
}

export function isAiWorkspaceToolResult(
  tool: AiWorkspaceToolName,
  value: unknown
): value is AiWorkspaceToolResult {
  if (tool === "list_project_files") return isListResult(value);
  if (tool === "read_project_file") return isReadResult(value);
  if (tool === "inspect_compilation") return isCompilationResult(value);
  if (tool === "list_typst_package_files") return isPackageListResult(value);
  if (tool === "read_typst_package_file") return isPackageReadResult(value);
  if (tool === "search_typst_package_text") return isPackageSearchResult(value);
  if (tool === "apply_patch" || tool === "write_file") return isEditResult(value);
  return isSearchResult(value);
}

export function isAiWorkspaceToolExecution(
  tool: AiWorkspaceToolName,
  value: unknown
): value is AiWorkspaceToolExecution {
  if (!isRecord(value) || typeof value.outcome !== "string") return false;
  if (value.outcome === "success") {
    return hasExactKeys(value, ["outcome", "result"]) && isAiWorkspaceToolResult(tool, value.result);
  }
  if (value.outcome !== "error" || !hasExactKeys(value, ["outcome", "error"])) return false;
  return (
    isRecord(value.error) &&
    hasExactKeys(value.error, ["code", "message"]) &&
    isAiWorkspaceToolErrorCode(value.error.code) &&
    isBoundedString(value.error.message, 512)
  );
}
