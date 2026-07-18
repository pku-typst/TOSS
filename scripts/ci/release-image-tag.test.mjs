import assert from "node:assert/strict";
import test from "node:test";

import { parseReleaseImageTag } from "./release-image-tag.mjs";

test("parses independent stable image releases", () => {
  assert.deepEqual(parseReleaseImageTag("app", "v0.1.0"), {
    version: "0.1.0",
    stable: true
  });
  assert.deepEqual(parseReleaseImageTag("latex-worker", "latex-worker-v2.3.4"), {
    version: "2.3.4",
    stable: true
  });
});

test("preserves valid prerelease identifiers without promoting latest", () => {
  assert.deepEqual(parseReleaseImageTag("app", "v1.2.3-rc.1"), {
    version: "1.2.3-rc.1",
    stable: false
  });
  assert.deepEqual(parseReleaseImageTag("latex-worker", "latex-worker-v0.4.0-alpha-2"), {
    version: "0.4.0-alpha-2",
    stable: false
  });
});

test("rejects ambiguous or malformed release tags", () => {
  for (const [release, tag] of [
    ["app", "0.1.0"],
    ["latex-worker", "v0.1.0"],
    ["app", "v1.2"],
    ["app", "v01.2.3"],
    ["app", "v1.2.3-01"],
    ["app", "v1.2.3+build.1"],
    ["app", "v1.2.3-"]
  ]) {
    assert.throws(() => parseReleaseImageTag(release, tag));
  }
});
