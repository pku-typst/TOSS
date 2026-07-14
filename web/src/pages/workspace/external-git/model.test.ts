import { describe, expect, it } from "vitest";
import {
  externalGitPhaseIndex,
  preferredInboundBranch,
  projectSlug,
  shouldPollExternalGitStatus,
  unavailableExternalGitStatus
} from "@/pages/workspace/external-git/model";

describe("external Git repository slug", () => {
  it("normalizes a project name into a Git-safe default path", () => {
    expect(projectSlug("Quarterly Slides 2026")).toBe("quarterly-slides-2026");
    expect(projectSlug("  demo__slides  ")).toBe("demo-slides");
  });

  it("uses a stable fallback when a name has no ASCII path characters", () => {
    expect(projectSlug("季度汇报")).toBe("typst-project");
  });
});

describe("external Git manual sync status", () => {
  it("does not poll merely because collaborators changed the platform workspace", () => {
    expect(shouldPollExternalGitStatus("dirty")).toBe(false);
    expect(shouldPollExternalGitStatus("active")).toBe(false);
  });

  it("polls only after an owner started a durable sync job", () => {
    expect(shouldPollExternalGitStatus("pending")).toBe(true);
    expect(shouldPollExternalGitStatus("syncing")).toBe(true);
    expect(shouldPollExternalGitStatus("retry_wait")).toBe(true);
  });

  it("maps worker phases to the visual progress steps", () => {
    expect(externalGitPhaseIndex("queued")).toBe(0);
    expect(externalGitPhaseIndex("snapshot")).toBe(0);
    expect(externalGitPhaseIndex("commit_local")).toBe(1);
    expect(externalGitPhaseIndex("push_git")).toBe(2);
  });

  it("builds an explicit unconfigured state without an API request", () => {
    const snapshot = unavailableExternalGitStatus("project-1");
    expect(snapshot.connection.configured).toBe(false);
    expect(snapshot.status).toMatchObject({
      project_id: "project-1",
      linked: false,
      state: "unlinked"
    });
  });

  it("prefers the last imported branch, then the repository default", () => {
    const branches = [
      {
        name: "main",
        default: true,
        protected: false,
        commit_sha: "main-sha",
        committed_at: null
      },
      {
        name: "slides",
        default: false,
        protected: false,
        commit_sha: "slides-sha",
        committed_at: null
      }
    ];
    expect(
      preferredInboundBranch(branches, {
        last_import_branch: "slides",
        default_branch: "main"
      })?.name
    ).toBe("slides");
    expect(
      preferredInboundBranch(branches, {
        last_import_branch: null,
        default_branch: "main"
      })?.name
    ).toBe("main");
  });
});
