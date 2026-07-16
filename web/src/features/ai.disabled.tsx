import type { Translator, UiLocale } from "@/lib/i18n";
import type { WorkspaceOptionalPanelDescriptor } from "@/pages/workspace/types";
import type { WorkspaceOptionalSettingsSectionDescriptor } from "@/pages/workspace/types";
import type { AiWorkspaceToolPort } from "@/features/ai/toolContract";
import type { AiWorkspaceContextSnapshot } from "@/features/ai/toolContract";
import type { AuthConfig } from "@/lib/api/types";
import type {
  AiWorkspaceCandidateCompileResult,
  AiWorkspacePortOptions,
  AiWorkspaceToolSource
} from "@/pages/workspace/assistantWorkspacePort";
import type {
  AssistantEditProposal,
  AssistantEditReviewDecision
} from "@/pages/workspace/assistantEditReview";
import type {
  CompileTarget,
  CompileWorld
} from "@/pages/workspace/compileWorld";
import type { WorkspaceCandidateCompilation } from "@/pages/workspace/candidateCompilation";

export const AI_ASSISTANT_PANEL_ID = "feature:ai_assistant" as const;

export function aiAssistantWorkspacePanel(
  _enabled: boolean,
  _active: boolean,
  _t: Translator
): WorkspaceOptionalPanelDescriptor | null {
  return null;
}

export function AiAssistantPanel(_props: {
  width: number;
  accountId: string | null;
  projectId: string;
  locale: UiLocale;
  workspacePort: AiWorkspaceToolPort;
  aiAssistantConfig: AuthConfig["ai_assistant"];
  onOpenSettings: () => void;
  t: Translator;
}) {
  return null;
}

export function aiAssistantSettingsSection(_props: {
  enabled: boolean;
  accountId: string | null;
  locale: UiLocale;
  aiAssistantConfig: AuthConfig["ai_assistant"];
  t: Translator;
}): WorkspaceOptionalSettingsSectionDescriptor | null {
  return null;
}

export function AssistantEditReviewPane(_props: {
  proposal: AssistantEditProposal;
  canAccept: boolean;
  onReject: () => void;
  onAccept: () => void;
  t: Translator;
}) {
  return null;
}

export class AssistantEditReviewCoordinator {
  private readonly snapshot = { proposal: null as AssistantEditProposal | null };
  constructor(readonly scopeId: string = "") {}
  readonly subscribe = (_listener: () => void) => () => undefined;
  readonly getSnapshot = () => this.snapshot;
  async request(
    _proposal: Omit<AssistantEditProposal, "id">,
    _signal?: AbortSignal
  ): Promise<AssistantEditReviewDecision> {
    return "cancelled";
  }
  accept(_id: string) { return false; }
  reject(_id: string) { return false; }
  markStale(_id: string) { return false; }
  dispose() {}
}

export function createAiWorkspacePort(
  options: AiWorkspacePortOptions
): AiWorkspaceToolPort {
  return {
    capabilities: {
      project_type: options.projectType,
      mode: options.mode,
      tools: []
    },
    getContextSnapshot: options.getContextSnapshot,
    async execute() {
      return {
        outcome: "error",
        error: {
          code: "workspace_tool_not_available",
          message: "workspace_tool_not_available"
        }
      };
    }
  };
}

export function compileWorldWithCandidateDocument(
  _world: CompileWorld,
  _path: string,
  _candidateText: string
): CompileWorld | null {
  return null;
}

export async function compileWorkspaceCandidate(
  _world: CompileWorld,
  _target: CompileTarget,
  _candidatePath: string,
  _signal?: AbortSignal
): Promise<WorkspaceCandidateCompilation> {
  return { errors: ["workspace_tool_not_available"], diagnostics: [] };
}

export type {
  AiWorkspaceCandidateCompileResult,
  AiWorkspacePortOptions,
  AiWorkspaceToolSource,
  AiWorkspaceContextSnapshot,
  AiWorkspaceToolPort,
  AssistantEditProposal,
  AssistantEditReviewDecision
};
