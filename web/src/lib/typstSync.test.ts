import { describe, expect, it } from "vitest";
import {
  clientPointToTypstPosition,
  incrementalMappingRevision,
  mapDocumentToSource,
  mapSourceToDocument,
  sourceByteOffsetToEditorPosition,
  utf16OffsetToUtf8ByteOffset,
  utf8ByteOffsetToUtf16Offset
} from "@/lib/typstSync";

describe("Typst source synchronization", () => {
  it("converts UTF-16 editor offsets and UTF-8 compiler offsets", () => {
    const source = "A😀é中\nnext";
    const afterEmoji = 3;
    expect(utf16OffsetToUtf8ByteOffset(source, afterEmoji)).toBe(5);
    expect(utf8ByteOffsetToUtf16Offset(source, 5)).toBe(afterEmoji);
    expect(utf8ByteOffsetToUtf16Offset("é", 1)).toBe(0);
    expect(sourceByteOffsetToEditorPosition(source, 11)).toEqual({
      offset: 6,
      line: 2,
      column: 1
    });
  });

  it("uses the public wrapper methods when available", () => {
    const server = {
      mappingRevision: 7,
      sourceToDocument: () => [{ pageOffset: 1, x: 12, y: 34 }],
      documentToSource: () => ({ path: "/main.typ", byteOffset: 9 })
    };
    expect(incrementalMappingRevision(server as never)).toBe(7);
    expect(mapSourceToDocument(server as never, { path: "/main.typ", byteOffset: 9 })).toEqual([
      { pageOffset: 1, x: 12, y: 34 }
    ]);
    expect(mapDocumentToSource(server as never, { pageOffset: 1, x: 12, y: 34 })).toEqual({
      path: "/main.typ",
      byteOffset: 9
    });
  });

  it("falls back to the raw wasm-bindgen server used by typst.ts 0.8", () => {
    const server = {
      [Symbol.for("reflexo-obj")]: {
        mapping_revision: 3,
        source_to_document: () => [{ pageOffset: 0, x: 4, y: 5 }],
        document_to_source: () => ({
          path: "/chapter.typ",
          package: "@ws/p0:0.0.0",
          byteOffset: 2
        })
      }
    };
    expect(incrementalMappingRevision(server as never)).toBe(3);
    expect(mapSourceToDocument(server as never, { path: "/chapter.typ", byteOffset: 2 })).toEqual([
      { pageOffset: 0, x: 4, y: 5 }
    ]);
    expect(mapDocumentToSource(server as never, { pageOffset: 0, x: 4, y: 5 })).toEqual({
      path: "/chapter.typ",
      byteOffset: 2
    });
  });

  it("converts a scaled canvas click into Typst page coordinates", () => {
    expect(
      clientPointToTypstPosition({
        pageOffset: 2,
        clientX: 150,
        clientY: 250,
        rect: { left: 50, top: 50, width: 200, height: 400 },
        pageWidth: 100,
        pageHeight: 200
      })
    ).toEqual({ pageOffset: 2, x: 50, y: 100 });
    expect(
      clientPointToTypstPosition({
        pageOffset: 0,
        clientX: 0,
        clientY: 0,
        rect: { left: Number.NaN, top: 0, width: 100, height: 100 },
        pageWidth: 100,
        pageHeight: 100
      })
    ).toBeUndefined();
  });
});
