import type { IncrementalServer } from "@myriaddreamin/typst.ts/compiler";

export type TypstSourcePosition = {
  path: string;
  byteOffset: number;
};

export type TypstDocumentPosition = {
  pageOffset: number;
  x: number;
  y: number;
};

export type TypstSourceLocation = TypstSourcePosition & {
  package?: string;
};

export type TypstMappingRequest =
  | {
      kind: "mapping.source-to-document";
      id: number;
      workspaceKey: string;
      expectedRevision: number;
      position: TypstSourcePosition;
    }
  | {
      kind: "mapping.document-to-source";
      id: number;
      workspaceKey: string;
      expectedRevision: number;
      position: TypstDocumentPosition;
    };

export type TypstMappingResponse = {
  kind: "mapping.result";
  id: number;
  ok: boolean;
  revision: number;
  stale?: boolean;
  positions?: TypstDocumentPosition[];
  location?: TypstSourceLocation;
  error?: string;
};

type MappingIncrementalServer = IncrementalServer & {
  readonly mappingRevision?: number;
  sourceToDocument?: (position: TypstSourcePosition) => unknown;
  documentToSource?: (position: TypstDocumentPosition) => unknown;
};

type RawMappingIncrementalServer = {
  readonly mapping_revision?: number;
  source_to_document?: (path: string, byteOffset: number) => unknown;
  document_to_source?: (pageOffset: number, x: number, y: number) => unknown;
};

const TYPST_INTERNAL_OBJECT = Symbol.for("reflexo-obj");

function rawIncrementalServer(server: IncrementalServer): RawMappingIncrementalServer | undefined {
  const owner = server as unknown as Record<symbol, unknown>;
  const raw = owner[TYPST_INTERNAL_OBJECT];
  return raw && typeof raw === "object" ? (raw as RawMappingIncrementalServer) : undefined;
}

function isDocumentPosition(value: unknown): value is TypstDocumentPosition {
  if (!value || typeof value !== "object") return false;
  const position = value as Partial<TypstDocumentPosition>;
  return (
    Number.isSafeInteger(position.pageOffset) &&
    (position.pageOffset ?? -1) >= 0 &&
    typeof position.x === "number" &&
    Number.isFinite(position.x) &&
    typeof position.y === "number" &&
    Number.isFinite(position.y)
  );
}

function isSourceLocation(value: unknown): value is TypstSourceLocation {
  if (!value || typeof value !== "object") return false;
  const location = value as Partial<TypstSourceLocation>;
  return (
    typeof location.path === "string" &&
    !!location.path &&
    Number.isSafeInteger(location.byteOffset) &&
    (location.byteOffset ?? -1) >= 0 &&
    (location.package === undefined || typeof location.package === "string")
  );
}

export function incrementalMappingRevision(server: IncrementalServer): number {
  const direct = server as MappingIncrementalServer;
  const revision = direct.mappingRevision ?? rawIncrementalServer(server)?.mapping_revision;
  return Number.isSafeInteger(revision) && (revision ?? -1) >= 0 ? revision! : 0;
}

export function mapSourceToDocument(
  server: IncrementalServer,
  position: TypstSourcePosition
): TypstDocumentPosition[] {
  const direct = server as MappingIncrementalServer;
  const result =
    typeof direct.sourceToDocument === "function"
      ? direct.sourceToDocument(position)
      : rawIncrementalServer(server)?.source_to_document?.(position.path, position.byteOffset);
  if (!Array.isArray(result)) return [];
  return result.filter(isDocumentPosition);
}

export function mapDocumentToSource(
  server: IncrementalServer,
  position: TypstDocumentPosition
): TypstSourceLocation | undefined {
  const direct = server as MappingIncrementalServer;
  const result =
    typeof direct.documentToSource === "function"
      ? direct.documentToSource(position)
      : rawIncrementalServer(server)?.document_to_source?.(
          position.pageOffset,
          position.x,
          position.y
        );
  if (!isSourceLocation(result)) return undefined;
  if (result.package?.startsWith("@ws/")) {
    return { path: result.path, byteOffset: result.byteOffset };
  }
  return result;
}

function normalizeUtf16Offset(text: string, offset: number): number {
  let safe = Math.min(text.length, Math.max(0, Math.trunc(offset)));
  if (safe <= 0 || safe >= text.length) return safe;
  const current = text.charCodeAt(safe);
  const previous = text.charCodeAt(safe - 1);
  if (current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
    safe -= 1;
  }
  return safe;
}

export function utf16OffsetToUtf8ByteOffset(text: string, offset: number): number {
  const safe = normalizeUtf16Offset(text, offset);
  return new TextEncoder().encode(text.slice(0, safe)).byteLength;
}

export function utf8ByteOffsetToUtf16Offset(text: string, byteOffset: number): number {
  const encoded = new TextEncoder().encode(text);
  let safe = Math.min(encoded.byteLength, Math.max(0, Math.trunc(byteOffset)));
  while (safe > 0 && safe < encoded.byteLength && (encoded[safe] & 0xc0) === 0x80) {
    safe -= 1;
  }
  return new TextDecoder().decode(encoded.subarray(0, safe)).length;
}

export function sourceByteOffsetToEditorPosition(text: string, byteOffset: number) {
  const offset = utf8ByteOffsetToUtf16Offset(text, byteOffset);
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    line += 1;
    lineStart = index + 1;
  }
  return {
    offset,
    line,
    column: offset - lineStart + 1
  };
}

export function clientPointToTypstPosition(options: {
  pageOffset: number;
  clientX: number;
  clientY: number;
  rect: { left: number; top: number; width: number; height: number };
  pageWidth: number;
  pageHeight: number;
}): TypstDocumentPosition | undefined {
  const { pageOffset, clientX, clientY, rect, pageWidth, pageHeight } = options;
  if (
    !Number.isSafeInteger(pageOffset) ||
    pageOffset < 0 ||
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY) ||
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.width) ||
    rect.width <= 0 ||
    !Number.isFinite(rect.height) ||
    rect.height <= 0 ||
    !Number.isFinite(pageWidth) ||
    pageWidth <= 0 ||
    !Number.isFinite(pageHeight) ||
    pageHeight <= 0
  ) {
    return undefined;
  }
  return {
    pageOffset,
    x: Math.min(pageWidth, Math.max(0, ((clientX - rect.left) / rect.width) * pageWidth)),
    y: Math.min(pageHeight, Math.max(0, ((clientY - rect.top) / rect.height) * pageHeight))
  };
}
