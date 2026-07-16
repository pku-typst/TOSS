import { AI_WORKSPACE_TOOL_LIMITS } from "@/features/ai/toolContract";

export type AssistantPatchCandidate = {
  candidateText: string;
  canonicalPatch: string;
  addedLines: number;
  removedLines: number;
  hunkCount: number;
};

export type AssistantPatchParseResult =
  | { ok: true; candidate: AssistantPatchCandidate }
  | { ok: false; reason: string };

type ParsedHunkLine = {
  kind: "context" | "remove" | "add";
  text: string;
};

type ParsedHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ParsedHunkLine[];
};

type DiffLine = {
  text: string;
  terminated: boolean;
};

type DiffOperation = {
  kind: "context" | "remove" | "add";
  line: DiffLine;
};

function failure(reason: string): AssistantPatchParseResult {
  return { ok: false, reason };
}

function coordinateIndex(start: number, count: number) {
  return count === 0 ? start : start - 1;
}

function parseHunkHeader(line: string) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
  if (!match) return null;
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  if (
    !Number.isSafeInteger(oldStart) ||
    !Number.isSafeInteger(oldCount) ||
    !Number.isSafeInteger(newStart) ||
    !Number.isSafeInteger(newCount) ||
    oldCount < 0 ||
    newCount < 0 ||
    (oldCount > 0 && oldStart < 1) ||
    (newCount > 0 && newStart < 1)
  ) return null;
  return { oldStart, oldCount, newStart, newCount };
}

function splitBaseText(text: string) {
  const hasCrLf = text.includes("\r\n");
  const withoutCrLf = text.replaceAll("\r\n", "");
  if (withoutCrLf.includes("\r")) return null;
  const eol = hasCrLf && !withoutCrLf.includes("\n") ? "\r\n" : "\n";
  const endsWithNewline = text.endsWith(eol);
  const lines = text.split(eol);
  if (endsWithNewline) lines.pop();
  return { eol, endsWithNewline, lines };
}

function splitDiffText(text: string): DiffLine[] | null {
  const normalized = text.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) return null;
  if (normalized.length === 0) return [];
  const endsWithNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (endsWithNewline) lines.pop();
  return lines.map((line, index) => ({
    text: line,
    terminated: index < lines.length - 1 || endsWithNewline
  }));
}

function sameDiffLine(left: DiffLine, right: DiffLine) {
  return left.text === right.text && left.terminated === right.terminated;
}

function diffOperations(before: readonly DiffLine[], after: readonly DiffLine[]) {
  const lengths = Array.from(
    { length: before.length + 1 },
    () => new Uint16Array(after.length + 1)
  );
  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      lengths[beforeIndex][afterIndex] = sameDiffLine(
        before[beforeIndex],
        after[afterIndex]
      )
        ? lengths[beforeIndex + 1][afterIndex + 1] + 1
        : Math.max(
            lengths[beforeIndex + 1][afterIndex],
            lengths[beforeIndex][afterIndex + 1]
          );
    }
  }

  const operations: DiffOperation[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < before.length || afterIndex < after.length) {
    if (
      beforeIndex < before.length &&
      afterIndex < after.length &&
      sameDiffLine(before[beforeIndex], after[afterIndex])
    ) {
      operations.push({ kind: "context", line: before[beforeIndex] });
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }
    if (
      beforeIndex < before.length &&
      (
        afterIndex >= after.length ||
        lengths[beforeIndex + 1][afterIndex] >= lengths[beforeIndex][afterIndex + 1]
      )
    ) {
      operations.push({ kind: "remove", line: before[beforeIndex] });
      beforeIndex += 1;
      continue;
    }
    operations.push({ kind: "add", line: after[afterIndex] });
    afterIndex += 1;
  }
  return operations;
}

function diffHunkRanges(operations: readonly DiffOperation[]) {
  const contextLines = 3;
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < operations.length; index += 1) {
    if (operations[index].kind === "context") continue;
    const start = Math.max(0, index - contextLines);
    const end = Math.min(operations.length, index + contextLines + 1);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start, end });
    }
  }
  return ranges;
}

function diffPositionBefore(operations: readonly DiffOperation[], end: number) {
  let oldLine = 1;
  let newLine = 1;
  for (let index = 0; index < end; index += 1) {
    if (operations[index].kind !== "add") oldLine += 1;
    if (operations[index].kind !== "remove") newLine += 1;
  }
  return { oldLine, newLine };
}

function renderDiffOperation(operation: DiffOperation) {
  const prefix = operation.kind === "context" ? " " : operation.kind === "remove" ? "-" : "+";
  return operation.line.terminated
    ? [`${prefix}${operation.line.text}`]
    : [`${prefix}${operation.line.text}`, "\\ No newline at end of file"];
}

/**
 * Builds the bounded canonical review diff for an exact full-file replacement.
 * This is presentation and review data; candidateText remains the write source
 * of truth and still passes through the shared compile/freshness pipeline.
 */
export function createAssistantUnifiedDiff(
  path: string,
  baseText: string,
  candidateText: string
): AssistantPatchParseResult {
  if (candidateText === baseText) return failure("patch_no_effect");
  const before = splitDiffText(baseText);
  const after = splitDiffText(candidateText);
  if (!before || !after) return failure("source_line_endings");
  if (
    before.length > AI_WORKSPACE_TOOL_LIMITS.maxReadLines ||
    after.length > AI_WORKSPACE_TOOL_LIMITS.maxReadLines
  ) return failure("patch_lines");
  const operations = diffOperations(before, after);
  const ranges = diffHunkRanges(operations);
  if (ranges.length === 0) return failure("patch_no_effect");
  if (ranges.length > AI_WORKSPACE_TOOL_LIMITS.maxPatchHunks) {
    return failure("patch_hunks");
  }

  const addedLines = operations.filter(({ kind }) => kind === "add").length;
  const removedLines = operations.filter(({ kind }) => kind === "remove").length;
  if (addedLines + removedLines > AI_WORKSPACE_TOOL_LIMITS.maxPatchChangedLines) {
    return failure("patch_changes");
  }

  const patchLines = [`--- a/${path}`, `+++ b/${path}`];
  for (const range of ranges) {
    const position = diffPositionBefore(operations, range.start);
    const body = operations.slice(range.start, range.end);
    const oldCount = body.filter(({ kind }) => kind !== "add").length;
    const newCount = body.filter(({ kind }) => kind !== "remove").length;
    const oldStart = oldCount === 0 ? position.oldLine - 1 : position.oldLine;
    const newStart = newCount === 0 ? position.newLine - 1 : position.newLine;
    patchLines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const operation of body) patchLines.push(...renderDiffOperation(operation));
  }
  const canonicalPatch = patchLines.join("\n");
  if (canonicalPatch.length > AI_WORKSPACE_TOOL_LIMITS.maxPatchCharacters) {
    return failure("patch_size");
  }
  return {
    ok: true,
    candidate: {
      candidateText,
      canonicalPatch,
      addedLines,
      removedLines,
      hunkCount: ranges.length
    }
  };
}

function parseHunks(lines: string[]): ParsedHunk[] | null {
  const hunks: ParsedHunk[] = [];
  let index = 2;
  while (index < lines.length) {
    const header = parseHunkHeader(lines[index]);
    if (!header) return null;
    index += 1;
    const body: ParsedHunkLine[] = [];
    let previousWasBody = false;
    while (index < lines.length && !lines[index].startsWith("@@ ")) {
      const line = lines[index];
      if (line.startsWith("--- a/") || line.startsWith("+++ b/")) return null;
      if (line === "\\ No newline at end of file") {
        if (!previousWasBody) return null;
        previousWasBody = false;
        index += 1;
        continue;
      }
      const prefix = line[0];
      if (prefix !== " " && prefix !== "-" && prefix !== "+") return null;
      body.push({
        kind: prefix === " " ? "context" : prefix === "-" ? "remove" : "add",
        text: line.slice(1)
      });
      previousWasBody = true;
      index += 1;
    }
    if (body.length === 0) return null;
    hunks.push({ ...header, lines: body });
    if (hunks.length > AI_WORKSPACE_TOOL_LIMITS.maxPatchHunks) return null;
  }
  return hunks.length > 0 ? hunks : null;
}

/**
 * Parses the deliberately narrow patch format accepted by the Assistant.
 * Paths, old-start anchors, and all context/removal lines must match exactly;
 * fuzzy application, creation, deletion, rename, binary and multi-file patches
 * are unsupported. Declared hunk counts and new-start coordinates are treated
 * as redundant model output and canonicalized from the validated hunk body.
 */
export function parseAssistantUnifiedDiff(
  path: string,
  baseText: string,
  patch: string
): AssistantPatchParseResult {
  if (
    patch.length === 0 ||
    patch.length > AI_WORKSPACE_TOOL_LIMITS.maxPatchCharacters ||
    patch.includes("\0")
  ) return failure("patch_size");
  const normalizedPatch = patch.replaceAll("\r\n", "\n");
  if (normalizedPatch.includes("\r")) return failure("patch_line_endings");
  const patchLines = normalizedPatch.split("\n");
  if (patchLines.at(-1) === "") patchLines.pop();
  if (
    patchLines.length < 3 ||
    patchLines[0] !== `--- a/${path}` ||
    patchLines[1] !== `+++ b/${path}`
  ) return failure("patch_paths");

  const hunks = parseHunks(patchLines);
  if (!hunks) return failure("patch_syntax");
  const base = splitBaseText(baseText);
  if (!base) return failure("source_line_endings");

  const candidateLines: string[] = [];
  const canonicalPatchLines = [`--- a/${path}`, `+++ b/${path}`];
  let sourceCursor = 0;
  let addedLines = 0;
  let removedLines = 0;
  for (const hunk of hunks) {
    const actualOldCount = hunk.lines.reduce(
      (count, line) => count + (line.kind === "add" ? 0 : 1),
      0
    );
    const actualNewCount = hunk.lines.reduce(
      (count, line) => count + (line.kind === "remove" ? 0 : 1),
      0
    );
    const oldIndex = coordinateIndex(hunk.oldStart, actualOldCount);
    const newIndex = candidateLines.length + (oldIndex - sourceCursor);
    if (
      oldIndex < sourceCursor ||
      oldIndex > base.lines.length
    ) return failure("hunk_coordinates");
    const canonicalNewStart = actualNewCount === 0 ? newIndex : newIndex + 1;
    canonicalPatchLines.push(
      `@@ -${hunk.oldStart},${actualOldCount} +${canonicalNewStart},${actualNewCount} @@`
    );
    canonicalPatchLines.push(...hunk.lines.map((line) => {
      const prefix = line.kind === "context" ? " " : line.kind === "remove" ? "-" : "+";
      return `${prefix}${line.text}`;
    }));
    candidateLines.push(...base.lines.slice(sourceCursor, oldIndex));
    sourceCursor = oldIndex;

    let consumedOld = 0;
    let producedNew = 0;
    let contextLines = 0;
    let changedLines = 0;
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        candidateLines.push(line.text);
        producedNew += 1;
        addedLines += 1;
        changedLines += 1;
        continue;
      }
      if (sourceCursor >= base.lines.length || base.lines[sourceCursor] !== line.text) {
        return failure("hunk_context");
      }
      sourceCursor += 1;
      consumedOld += 1;
      if (line.kind === "context") {
        candidateLines.push(line.text);
        producedNew += 1;
        contextLines += 1;
      } else {
        removedLines += 1;
        changedLines += 1;
      }
    }
    if (
      consumedOld !== actualOldCount ||
      producedNew !== actualNewCount ||
      contextLines === 0 ||
      changedLines === 0
    ) return failure("hunk_counts");
    if (
      addedLines + removedLines > AI_WORKSPACE_TOOL_LIMITS.maxPatchChangedLines
    ) return failure("patch_changes");
  }
  candidateLines.push(...base.lines.slice(sourceCursor));
  const candidateText = candidateLines.join(base.eol) + (base.endsWithNewline ? base.eol : "");
  if (candidateText === baseText) return failure("patch_no_effect");
  return {
    ok: true,
    candidate: {
      candidateText,
      canonicalPatch: canonicalPatchLines.join("\n"),
      addedLines,
      removedLines,
      hunkCount: hunks.length
    }
  };
}
