import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { minimalTextChange } from "@/lib/editorSync";

describe("collaborative editor value synchronization", () => {
  it("does nothing when the editor already has the requested value", () => {
    expect(minimalTextChange("same", "same")).toBeNull();
  });

  it("keeps the common prefix and suffix outside the replacement", () => {
    expect(minimalTextChange("hello brave world", "hello shared world")).toEqual({
      from: 6,
      to: 11,
      insert: "shared"
    });
  });

  it("lets CodeMirror map a cursor through a remote insertion", () => {
    const current = "first\nsecond";
    const next = "remote\nfirst\nsecond";
    const change = minimalTextChange(current, next);
    expect(change).not.toBeNull();

    const state = EditorState.create({
      doc: current,
      selection: { anchor: current.length }
    });
    const transaction = state.update({ changes: change ?? undefined });

    expect(transaction.state.doc.toString()).toBe(next);
    expect(transaction.state.selection.main.head).toBe(next.length);
  });

  it("does not move a cursor when the remote edit is after it", () => {
    const current = "alpha beta";
    const next = "alpha beta gamma";
    const change = minimalTextChange(current, next);
    const state = EditorState.create({
      doc: current,
      selection: { anchor: 5 }
    });

    const transaction = state.update({ changes: change ?? undefined });

    expect(transaction.state.selection.main.head).toBe(5);
  });
});
