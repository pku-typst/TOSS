import {
  AI_WORKSPACE_TOOL_LIMITS,
  AI_WORKSPACE_TOOL_NAMES,
  isAiWorkspaceToolArguments,
  type AiApplyPatchArguments,
  type AiListProjectFilesArguments,
  type AiReadProjectFileArguments,
  type AiSearchProjectTextArguments,
  type AiPatchCompileVerification,
  type AiWorkspaceCapabilities,
  type AiWorkspaceContextSnapshot,
  type AiWorkspaceToolErrorCode,
  type AiWorkspaceToolExecution,
  type AiWorkspaceToolPort,
  type AiWorkspaceToolRequest,
  type AiWorkspaceToolResult,
  type AiWriteFileArguments
} from "@/features/ai/toolContract";
import {
  createAssistantUnifiedDiff,
  parseAssistantUnifiedDiff,
  type AssistantPatchCandidate
} from "@/pages/workspace/assistantPatch";
import type {
  AssistantEditProposal,
  AssistantEditReviewDecision
} from "@/pages/workspace/assistantEditReview";
import type { DocumentIdentity, ProjectNode } from "@/pages/workspace/types";

const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_SEARCH_RESULTS = 50;
const MAX_SEARCH_FILES = 500;
const MAX_SEARCH_CHARACTERS = 2_000_000;

/** Workspace-owned projection exposed through the Assistant integration port. */
export type AiWorkspaceToolSource = {
  scopeId: string;
  projectType: "typst" | "latex";
  mode: "live" | "revision";
  entryFilePath: string;
  activePath: string;
  nodes: readonly ProjectNode[];
  documents: Readonly<Record<string, string>>;
  activeDocument: { path: string; text: string } | null;
  documentIdentities: Readonly<Record<string, DocumentIdentity>>;
};

export type AiWorkspacePortOptions = {
  scopeId: string;
  projectType: "typst" | "latex";
  mode: "live" | "revision";
  allowEdits: boolean;
  getContextSnapshot: () => AiWorkspaceContextSnapshot;
  getSource: () => AiWorkspaceToolSource;
  verifyCandidate: (
    candidate: {
      path: string;
      baseText: string;
      candidateText: string;
    },
    signal?: AbortSignal
  ) => Promise<AiWorkspaceCandidateCompileResult>;
  isCandidateRevisionCurrent: (revision: object) => boolean;
  requestEditReview: (
    proposal: Omit<AssistantEditProposal, "id">,
    signal?: AbortSignal
  ) => Promise<AssistantEditReviewDecision>;
};

export type AiWorkspaceCandidateCompileResult =
  | {
      outcome: "completed";
      revision: object;
      errors: readonly string[];
      diagnostics: readonly {
        severity: "error" | "warning" | "info";
        message: string;
        path?: string;
        line?: number;
        column?: number;
      }[];
    }
  | {
      outcome: "unavailable";
      reason: "workspace_sync_pending" | "compiler_world_stale" | "document_missing";
    };

function toolError(
  code: AiWorkspaceToolErrorCode,
  message: string
): AiWorkspaceToolExecution {
  return { outcome: "error", error: { code, message } };
}

function toolSuccess(result: AiWorkspaceToolResult): AiWorkspaceToolExecution {
  return { outcome: "success", result };
}

function normalizeRelativePath(value: string, allowEmpty: boolean) {
  if (value.length === 0) return allowEmpty ? "" : null;
  if (
    value.length > AI_WORKSPACE_TOOL_LIMITS.maxPathLength ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) return null;
  const normalized = allowEmpty ? value.replace(/\/+$/, "") : value;
  if (normalized.length === 0) return allowEmpty ? "" : null;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return null;
  }
  return normalized;
}

function pathMatchesPrefix(path: string, prefix: string) {
  return prefix.length === 0 || path === prefix || path.startsWith(`${prefix}/`);
}

function sourceDocument(source: AiWorkspaceToolSource, path: string) {
  if (source.activeDocument?.path === path) return source.activeDocument.text;
  if (Object.prototype.hasOwnProperty.call(source.documents, path)) return source.documents[path];
  return null;
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function boundedCompileMessage(value: string) {
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.slice(0, AI_WORKSPACE_TOOL_LIMITS.maxCompileMessageLength);
}

function compileVerification(
  result: Extract<AiWorkspaceCandidateCompileResult, { outcome: "completed" }>
): AiPatchCompileVerification {
  let truncated =
    result.errors.length > AI_WORKSPACE_TOOL_LIMITS.maxCompileErrors ||
    result.diagnostics.length > AI_WORKSPACE_TOOL_LIMITS.maxCompileDiagnostics;
  const errors: string[] = [];
  for (const raw of result.errors) {
    const message = boundedCompileMessage(raw);
    if (!message) continue;
    if (raw.trim().length > message.length) truncated = true;
    if (errors.length >= AI_WORKSPACE_TOOL_LIMITS.maxCompileErrors) {
      truncated = true;
      break;
    }
    errors.push(message);
  }
  const diagnostics: AiPatchCompileVerification["diagnostics"] = [];
  for (const raw of result.diagnostics) {
    const message = boundedCompileMessage(raw.message);
    if (!message) continue;
    if (raw.message.trim().length > message.length) truncated = true;
    if (diagnostics.length >= AI_WORKSPACE_TOOL_LIMITS.maxCompileDiagnostics) {
      truncated = true;
      break;
    }
    diagnostics.push({
      severity: raw.severity,
      message,
      path: raw.path?.slice(0, AI_WORKSPACE_TOOL_LIMITS.maxPathLength) || null,
      line: Number.isSafeInteger(raw.line) && (raw.line ?? 0) > 0 ? raw.line! : null,
      column: Number.isSafeInteger(raw.column) && (raw.column ?? 0) > 0 ? raw.column! : null
    });
  }
  return {
    status: errors.length > 0 || diagnostics.some(({ severity }) => severity === "error")
      ? "failed"
      : "passed",
    errors,
    diagnostics,
    truncated
  };
}

async function snapshotId(
  source: AiWorkspaceToolSource,
  path: string,
  text: string,
  signal?: AbortSignal
) {
  checkAbort(signal);
  const identity = source.documentIdentities[path];
  const input = JSON.stringify([
    source.scopeId,
    source.mode,
    path,
    identity?.id ?? null,
    identity?.pathRevision ?? null,
    identity?.collaborationRevision ?? null,
    text
  ]);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  checkAbort(signal);
  return `sha256-${Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0")
  ).join("")}`;
}

function listProjectFiles(
  source: AiWorkspaceToolSource,
  args: AiListProjectFilesArguments
): AiWorkspaceToolExecution {
  const prefix = normalizeRelativePath(args.path_prefix ?? "", true);
  if (prefix === null) return toolError("workspace_invalid_path", "The path prefix is invalid.");
  const offset = args.offset ?? 0;
  const limit = args.limit ?? DEFAULT_LIST_LIMIT;
  const entries = source.nodes
    .filter((node) => pathMatchesPrefix(node.path, prefix))
    .map((node) => ({
      path: node.path,
      kind: node.kind === "directory"
        ? "directory" as const
        : sourceDocument(source, node.path) !== null
          ? "text" as const
          : "asset" as const
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const page = entries.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return toolSuccess({
    project_type: source.projectType,
    mode: source.mode,
    entry_file_path: source.entryFilePath,
    active_path: source.activePath,
    entries: page,
    offset,
    total: entries.length,
    next_offset: nextOffset < entries.length ? nextOffset : null
  });
}

async function readProjectFile(
  source: AiWorkspaceToolSource,
  args: AiReadProjectFileArguments,
  signal?: AbortSignal
): Promise<AiWorkspaceToolExecution> {
  const path = normalizeRelativePath(args.path, false);
  if (path === null) return toolError("workspace_invalid_path", "The file path is invalid.");
  const node = source.nodes.find((candidate) => candidate.path === path);
  if (!node || node.kind !== "file") {
    return toolError("workspace_file_not_found", "The requested project file does not exist.");
  }
  const text = sourceDocument(source, path);
  if (text === null) {
    return Object.prototype.hasOwnProperty.call(source.documentIdentities, path)
      ? toolError("workspace_file_unavailable", "The text file is not available in this Workspace snapshot.")
      : toolError("workspace_file_not_text", "The requested project file is not a text document.");
  }
  const lines = text.split("\n");
  const startLine = args.start_line ?? 1;
  if (startLine > lines.length) {
    return toolError("workspace_invalid_arguments", "The requested start line is past the end of the file.");
  }
  const requestedEndLine = args.end_line ?? Math.min(
    lines.length,
    startLine + AI_WORKSPACE_TOOL_LIMITS.maxReadLines - 1
  );
  if (
    requestedEndLine < startLine ||
    requestedEndLine - startLine + 1 > AI_WORKSPACE_TOOL_LIMITS.maxReadLines
  ) {
    return toolError("workspace_invalid_arguments", "The requested line range is invalid or too large.");
  }
  const boundedEndLine = Math.min(requestedEndLine, lines.length);
  const width = String(boundedEndLine).length;
  const numbered: string[] = [];
  let characterCount = 0;
  let contentTruncated = false;
  let actualEndLine = startLine;
  for (let lineNumber = startLine; lineNumber <= boundedEndLine; lineNumber += 1) {
    checkAbort(signal);
    const rendered = `${String(lineNumber).padStart(width, " ")} | ${lines[lineNumber - 1]}`;
    const separatorLength = numbered.length === 0 ? 0 : 1;
    const remaining = AI_WORKSPACE_TOOL_LIMITS.maxReadCharacters - characterCount - separatorLength;
    if (rendered.length > remaining) {
      if (remaining > 0) {
        numbered.push(rendered.slice(0, remaining));
        actualEndLine = lineNumber;
      }
      contentTruncated = true;
      break;
    }
    numbered.push(rendered);
    characterCount += separatorLength + rendered.length;
    actualEndLine = lineNumber;
  }
  const digest = await snapshotId(source, path, text, signal);
  return toolSuccess({
    path,
    snapshot_id: digest,
    start_line: startLine,
    end_line: actualEndLine,
    total_lines: lines.length,
    has_more: contentTruncated || actualEndLine < lines.length,
    content_truncated: contentTruncated,
    numbered_content: numbered.join("\n")
  });
}

function searchExcerpt(lineNumber: number, line: string, matchIndex: number) {
  const prefix = `${lineNumber} | `;
  const contentBudget = Math.max(
    1,
    AI_WORKSPACE_TOOL_LIMITS.maxSearchExcerptLength - prefix.length
  );
  if (line.length <= contentBudget) return `${prefix}${line}`;
  const windowStart = Math.max(
    0,
    Math.min(matchIndex - Math.floor(contentBudget / 3), line.length - contentBudget + 2)
  );
  const leading = windowStart > 0 ? "…" : "";
  const available = contentBudget - leading.length - 1;
  const body = line.slice(windowStart, windowStart + available);
  const trailing = windowStart + available < line.length ? "…" : "";
  return `${prefix}${leading}${body}${trailing}`.slice(
    0,
    AI_WORKSPACE_TOOL_LIMITS.maxSearchExcerptLength
  );
}

function searchProjectText(
  source: AiWorkspaceToolSource,
  args: AiSearchProjectTextArguments,
  signal?: AbortSignal
): AiWorkspaceToolExecution {
  const prefix = normalizeRelativePath(args.path_prefix ?? "", true);
  if (prefix === null) return toolError("workspace_invalid_path", "The path prefix is invalid.");
  const query = args.query;
  const caseSensitive = args.case_sensitive ?? false;
  const needle = caseSensitive ? query : query.toLowerCase();
  const maxResults = args.max_results ?? DEFAULT_SEARCH_RESULTS;
  const textPaths = source.nodes
    .filter((node) => (
      node.kind === "file" &&
      pathMatchesPrefix(node.path, prefix) &&
      sourceDocument(source, node.path) !== null
    ))
    .map((node) => node.path)
    .sort((left, right) => left.localeCompare(right));
  const matches: Array<{
    path: string;
    line: number;
    column: number;
    numbered_excerpt: string;
  }> = [];
  let filesSearched = 0;
  let charactersSearched = 0;
  let truncated = false;
  search: for (const path of textPaths) {
    checkAbort(signal);
    if (filesSearched >= MAX_SEARCH_FILES) {
      truncated = true;
      break;
    }
    const text = sourceDocument(source, path) ?? "";
    if (charactersSearched + text.length > MAX_SEARCH_CHARACTERS) {
      truncated = true;
      break;
    }
    charactersSearched += text.length;
    filesSearched += 1;
    const lines = text.split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      checkAbort(signal);
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
          path,
          line: lineIndex + 1,
          column: matchIndex + 1,
          numbered_excerpt: searchExcerpt(lineIndex + 1, line, matchIndex)
        });
        fromIndex = matchIndex + Math.max(needle.length, 1);
      }
    }
  }
  return toolSuccess({
    query,
    case_sensitive: caseSensitive,
    files_searched: filesSearched,
    matches,
    truncated
  });
}

type ActiveEditBase = {
  path: string;
  baseText: string;
  currentSnapshot: string;
};

type ActiveEditBaseResult =
  | { ok: true; edit: ActiveEditBase }
  | { ok: false; execution: AiWorkspaceToolExecution };

async function resolveActiveEditBase(
  source: AiWorkspaceToolSource,
  pathValue: string,
  baseSnapshot: string,
  signal?: AbortSignal
): Promise<ActiveEditBaseResult> {
  const path = normalizeRelativePath(pathValue, false);
  if (path === null) {
    return { ok: false, execution: toolError("workspace_invalid_path", "The file path is invalid.") };
  }
  if (source.mode !== "live") {
    return {
      ok: false,
      execution: toolError("workspace_permission_denied", "Historical revisions cannot be edited.")
    };
  }
  if (source.activeDocument?.path !== path) {
    return {
      ok: false,
      execution: toolError(
        "workspace_document_not_active",
        "The first edit slice can only review the active text document."
      )
    };
  }
  const node = source.nodes.find((candidate) => candidate.path === path);
  if (!node || node.kind !== "file") {
    return {
      ok: false,
      execution: toolError("workspace_file_not_found", "The requested project file does not exist.")
    };
  }
  const baseText = source.activeDocument.text;
  const currentSnapshot = await snapshotId(source, path, baseText, signal);
  if (currentSnapshot !== baseSnapshot) {
    return {
      ok: false,
      execution: toolError(
        "workspace_snapshot_stale",
        "The file changed after it was read. Read it again before proposing another edit."
      )
    };
  }
  return { ok: true, edit: { path, baseText, currentSnapshot } };
}

function normalizeFullFileContent(baseText: string, content: string) {
  const baseWithoutCrLf = baseText.replaceAll("\r\n", "");
  const baseHasCrLf = baseText.includes("\r\n");
  if (baseWithoutCrLf.includes("\r")) return null;
  if (baseHasCrLf && baseWithoutCrLf.includes("\n")) return null;

  let normalized = content.replaceAll("\r\n", "\n");
  if (normalized.includes("\r") || normalized.includes("\0")) return null;
  const baseEndsWithNewline = baseHasCrLf
    ? baseText.endsWith("\r\n")
    : baseText.endsWith("\n");
  if (baseEndsWithNewline && !normalized.endsWith("\n")) normalized += "\n";
  const candidateText = baseHasCrLf ? normalized.replaceAll("\n", "\r\n") : normalized;
  return candidateText.length <= AI_WORKSPACE_TOOL_LIMITS.maxWriteFileCharacters
    ? candidateText
    : null;
}

async function completeCandidateEdit(
  source: AiWorkspaceToolSource,
  edit: ActiveEditBase,
  candidate: AssistantPatchCandidate,
  editKind: "patch" | "full-file",
  getSource: AiWorkspacePortOptions["getSource"],
  verifyCandidate: AiWorkspacePortOptions["verifyCandidate"],
  isCandidateRevisionCurrent: AiWorkspacePortOptions["isCandidateRevisionCurrent"],
  requestEditReview: AiWorkspacePortOptions["requestEditReview"],
  signal?: AbortSignal
): Promise<AiWorkspaceToolExecution> {
  let compiled: AiWorkspaceCandidateCompileResult;
  try {
    compiled = await verifyCandidate({
      path: edit.path,
      baseText: edit.baseText,
      candidateText: candidate.candidateText
    }, signal);
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw error;
    }
    return toolError(
      "workspace_candidate_compile_unavailable",
      "The isolated candidate compiler could not complete."
    );
  }
  if (compiled.outcome === "unavailable") {
    const message = compiled.reason === "workspace_sync_pending"
      ? "The Workspace source or required assets are still synchronizing."
      : compiled.reason === "compiler_world_stale"
        ? "The compiler World has not caught up with the active document yet."
        : "The candidate document is not present in the compiler World.";
    return toolError(
      "workspace_candidate_compile_unavailable",
      message
    );
  }
  const verification = compileVerification(compiled);
  const latestSource = getSource();
  if (latestSource.scopeId !== source.scopeId) {
    return toolError("workspace_scope_changed", "The Workspace scope changed while compiling the edit.");
  }
  const latestText = sourceDocument(latestSource, edit.path);
  const latestSnapshot = latestText === null
    ? null
    : await snapshotId(latestSource, edit.path, latestText, signal);
  if (
    latestSnapshot !== edit.currentSnapshot ||
    !isCandidateRevisionCurrent(compiled.revision)
  ) {
    return toolError(
      "workspace_snapshot_stale",
      "The project changed while the candidate edit was compiling. Read it again before retrying."
    );
  }
  if (verification.status === "failed") {
    return toolSuccess({
      path: edit.path,
      base_snapshot: edit.currentSnapshot,
      status: "compile_failed",
      snapshot_id: null,
      verification
    });
  }
  const decision = await requestEditReview({
    editKind,
    path: edit.path,
    baseSnapshot: edit.currentSnapshot,
    baseText: edit.baseText,
    candidateText: candidate.candidateText,
    patch: candidate.canonicalPatch,
    addedLines: candidate.addedLines,
    removedLines: candidate.removedLines,
    hunkCount: candidate.hunkCount,
    verification,
    verificationRevision: compiled.revision
  }, signal);
  if (decision === "cancelled") {
    return toolError("workspace_request_cancelled", "The edit review was cancelled.");
  }
  if (decision === "busy") {
    return toolError(
      "workspace_review_in_progress",
      "Another edit is already waiting for review."
    );
  }
  return toolSuccess({
    path: edit.path,
    base_snapshot: edit.currentSnapshot,
    status: decision,
    snapshot_id: decision === "accepted"
      ? await snapshotId(source, edit.path, candidate.candidateText, signal)
      : null,
    verification
  });
}

async function applyPatch(
  source: AiWorkspaceToolSource,
  args: AiApplyPatchArguments,
  getSource: AiWorkspacePortOptions["getSource"],
  verifyCandidate: AiWorkspacePortOptions["verifyCandidate"],
  isCandidateRevisionCurrent: AiWorkspacePortOptions["isCandidateRevisionCurrent"],
  requestEditReview: AiWorkspacePortOptions["requestEditReview"],
  signal?: AbortSignal
) {
  const base = await resolveActiveEditBase(source, args.path, args.base_snapshot, signal);
  if (!base.ok) return base.execution;
  const parsed = parseAssistantUnifiedDiff(base.edit.path, base.edit.baseText, args.patch);
  if (!parsed.ok) {
    return toolError(
      "workspace_patch_invalid",
      `The unified diff is invalid (${parsed.reason}).`
    );
  }
  return completeCandidateEdit(
    source,
    base.edit,
    parsed.candidate,
    "patch",
    getSource,
    verifyCandidate,
    isCandidateRevisionCurrent,
    requestEditReview,
    signal
  );
}

async function writeFile(
  source: AiWorkspaceToolSource,
  args: AiWriteFileArguments,
  fullReadSnapshots: ReadonlyMap<string, string>,
  getSource: AiWorkspacePortOptions["getSource"],
  verifyCandidate: AiWorkspacePortOptions["verifyCandidate"],
  isCandidateRevisionCurrent: AiWorkspacePortOptions["isCandidateRevisionCurrent"],
  requestEditReview: AiWorkspacePortOptions["requestEditReview"],
  signal?: AbortSignal
) {
  const base = await resolveActiveEditBase(source, args.path, args.base_snapshot, signal);
  if (!base.ok) return base.execution;
  if (fullReadSnapshots.get(base.edit.path) !== base.edit.currentSnapshot) {
    return toolError(
      "workspace_full_read_required",
      "write_file requires one complete, untruncated read_project_file result for this exact snapshot."
    );
  }
  const candidateText = normalizeFullFileContent(base.edit.baseText, args.content);
  if (candidateText === null) {
    return toolError(
      "workspace_invalid_arguments",
      "The replacement content has unsupported line endings, NUL data, or exceeds the write limit."
    );
  }
  const generated = createAssistantUnifiedDiff(base.edit.path, base.edit.baseText, candidateText);
  if (!generated.ok) {
    return toolError(
      "workspace_invalid_arguments",
      `The full-file replacement cannot produce a bounded review diff (${generated.reason}).`
    );
  }
  return completeCandidateEdit(
    source,
    base.edit,
    generated.candidate,
    "full-file",
    getSource,
    verifyCandidate,
    isCandidateRevisionCurrent,
    requestEditReview,
    signal
  );
}

export function createAiWorkspacePort({
  scopeId,
  projectType,
  mode,
  allowEdits,
  getContextSnapshot,
  getSource,
  verifyCandidate,
  isCandidateRevisionCurrent,
  requestEditReview
}: AiWorkspacePortOptions): AiWorkspaceToolPort {
  const fullReadSnapshots = new Map<string, string>();
  const capabilities: AiWorkspaceCapabilities = {
    project_type: projectType,
    mode,
    tools: AI_WORKSPACE_TOOL_NAMES.filter((tool) => (
      tool !== "apply_patch" && tool !== "write_file"
    ) || (allowEdits && mode === "live"))
  };
  return {
    capabilities,
    getContextSnapshot,
    async execute(request: AiWorkspaceToolRequest, signal?: AbortSignal) {
      try {
        checkAbort(signal);
        if (!isAiWorkspaceToolArguments(request.tool, request.arguments)) {
          return toolError("workspace_invalid_arguments", "The tool arguments are invalid.");
        }
        if (!capabilities.tools.includes(request.tool)) {
          return toolError("workspace_tool_not_available", "The Workspace tool is not available.");
        }
        const source = getSource();
        if (
          source.scopeId !== scopeId ||
          source.projectType !== capabilities.project_type ||
          source.mode !== capabilities.mode
        ) {
          return toolError("workspace_scope_changed", "The Workspace scope changed before the tool ran.");
        }
        if (request.tool === "list_project_files") {
          return listProjectFiles(source, request.arguments);
        }
        if (request.tool === "read_project_file") {
          const result = await readProjectFile(source, request.arguments, signal);
          if (getSource().scopeId !== scopeId) {
            return toolError("workspace_scope_changed", "The Workspace scope changed while the tool ran.");
          }
          if (
            result.outcome === "success" &&
            "numbered_content" in result.result &&
            result.result.start_line === 1 &&
            result.result.end_line === result.result.total_lines &&
            !result.result.has_more &&
            !result.result.content_truncated
          ) {
            fullReadSnapshots.set(result.result.path, result.result.snapshot_id);
          }
          return result;
        }
        if (request.tool === "search_project_text") {
          return searchProjectText(source, request.arguments, signal);
        }
        const result = request.tool === "apply_patch"
          ? await applyPatch(
              source,
              request.arguments,
              getSource,
              verifyCandidate,
              isCandidateRevisionCurrent,
              requestEditReview,
              signal
            )
          : await writeFile(
              source,
              request.arguments,
              fullReadSnapshots,
              getSource,
              verifyCandidate,
              isCandidateRevisionCurrent,
              requestEditReview,
              signal
            );
        if (
          request.tool === "write_file" &&
          result.outcome === "success" &&
          "status" in result.result &&
          result.result.status === "accepted"
        ) fullReadSnapshots.delete(request.arguments.path);
        if (getSource().scopeId !== scopeId) {
          return toolError("workspace_scope_changed", "The Workspace scope changed while the tool ran.");
        }
        return result;
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          return toolError("workspace_request_cancelled", "The Workspace tool call was cancelled.");
        }
        return toolError("workspace_tool_internal_error", "The Workspace tool could not complete safely.");
      }
    }
  };
}
