import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearProjectSnapshotCaches,
  loadProjectSnapshotFromCache,
  saveProjectSnapshotToCache
} from "@/lib/projectCache";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys()).at(index) ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("project snapshot cache identity boundaries", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not return one account's project snapshot to another account", () => {
    saveProjectSnapshotToCache({
      cacheIdentity: "user-a",
      projectId: "shared-project-id",
      entryFilePath: "main.typ",
      nodes: [{ path: "main.typ", kind: "file" }],
      docs: { "main.typ": "= Account A" }
    });

    expect(loadProjectSnapshotFromCache("user-a", "shared-project-id")?.docs["main.typ"]).toBe(
      "= Account A"
    );
    expect(loadProjectSnapshotFromCache("user-b", "shared-project-id")).toBeNull();
  });

  it("removes unsafe legacy entries and clears all scoped snapshots on logout", () => {
    storage.setItem("typst.project.cache.legacy-project", "legacy-content");
    saveProjectSnapshotToCache({
      cacheIdentity: "user-a",
      projectId: "project-a",
      entryFilePath: "main.typ",
      nodes: [],
      docs: {}
    });

    expect(storage.getItem("typst.project.cache.legacy-project")).toBeNull();
    expect(storage.length).toBe(1);
    clearProjectSnapshotCaches();
    expect(storage.length).toBe(0);
  });
});
