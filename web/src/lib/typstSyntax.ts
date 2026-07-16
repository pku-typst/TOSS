import { TypstParser, typstHighlight } from "codemirror-lang-typst";
import type { CompileDiagnostic } from "@/lib/typst";

const SYNTAX_ERROR_MESSAGE =
  "The Typst syntax parser found invalid or incomplete syntax.";

/** Centralizes the constructor omitted by codemirror-lang-typst's declarations. */
export function createTypstParser() {
  return new (
    TypstParser as unknown as new (highlighting: unknown) => TypstParser
  )(typstHighlight);
}

function positionAt(source: string, offset: number) {
  const boundedOffset = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < boundedOffset; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: boundedOffset - lineStart + 1 };
}

/**
 * Runs the official Typst syntax parser without initializing a compiler World.
 * The parser is error-recovering, so every distinct Error node is reported.
 */
export function checkTypstSyntax(
  path: string,
  source: string,
): CompileDiagnostic[] {
  const parser = createTypstParser();
  const tree = parser.parse(source);
  const cursor = tree.cursor();
  const diagnostics: CompileDiagnostic[] = [];

  do {
    if (cursor.name !== "Error") continue;
    const { line, column } = positionAt(source, cursor.from);
    diagnostics.push({
      severity: "error",
      message: SYNTAX_ERROR_MESSAGE,
      path,
      line,
      column,
      raw: `${path}:${line}:${column}: ${SYNTAX_ERROR_MESSAGE}`,
    });
    break;
  } while (cursor.next());

  parser.clearParser();
  return diagnostics;
}
