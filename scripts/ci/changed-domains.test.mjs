import assert from "node:assert/strict";
import test from "node:test";

import { classifyChangedPaths } from "./changed-domains.mjs";

const ALL_DOMAINS = {
  backend: true,
  container: true,
  workers: true,
  web: true,
  web_static: true,
  integration: true,
};
const NO_DOMAINS = Object.fromEntries(
  Object.keys(ALL_DOMAINS).map((domain) => [domain, false]),
);

test("documentation changes require preflight only", () => {
  assert.deepEqual(classifyChangedPaths(["README.md", "docs/community/help.md"]), {
    classification: "preflight",
    domains: NO_DOMAINS,
  });
});

test("documentation is neutral alongside worker changes", () => {
  assert.deepEqual(
    classifyChangedPaths([
      "workers/latex-worker/src/main.rs",
      "docs/community/operations/deployment.md",
    ]),
    {
      classification: "worker",
      domains: { ...NO_DOMAINS, workers: true },
    },
  );
});

test("application changes run the complete application pipeline", () => {
  assert.deepEqual(classifyChangedPaths(["web/src/App.tsx", "protocol/openapi.json"]), {
    classification: "app",
    domains: { ...ALL_DOMAINS, workers: false },
  });
});

test("cross-domain changes fall back to the full pipeline", () => {
  assert.deepEqual(
    classifyChangedPaths(["backend/src/main.rs", "workers/latex-worker/Cargo.toml"]),
    { classification: "full", domains: ALL_DOMAINS },
  );
});

test("CI orchestration and unknown paths fall back to the full pipeline", () => {
  for (const path of [
    ".github/workflows/ci.yml",
    ".dockerignore",
    ".env.example",
    "compose.build.yaml",
    "scripts/ci/changed-domains.mjs",
    "scripts/ci/common.sh",
    "rust-toolchain.toml",
    "unexpected/new-build-input",
  ]) {
    assert.deepEqual(classifyChangedPaths([path]), {
      classification: "full",
      domains: ALL_DOMAINS,
    });
  }
});

test("an empty diff fails safe to the full pipeline", () => {
  assert.deepEqual(classifyChangedPaths([]), {
    classification: "full",
    domains: ALL_DOMAINS,
  });
});
