import { lazy, Suspense } from "react";
import { Sparkles } from "lucide-react";
import { AI_ASSISTANT_PANEL_ID } from "@/features/ai/protocol";
import type { Translator, UiLocale } from "@/lib/i18n";
import type { WorkspaceOptionalPanelDescriptor } from "@/pages/workspace/types";
import type { AiWorkspaceToolPort } from "@/features/ai/toolContract";

const AssistantPanel = lazy(() => import("@/features/ai/AssistantPanel"));

export function aiAssistantWorkspacePanel(
  enabled: boolean,
  active: boolean,
  t: Translator
): WorkspaceOptionalPanelDescriptor | null {
  if (!enabled) return null;
  return {
    panel: AI_ASSISTANT_PANEL_ID,
    label: t("workspace.assistant"),
    icon: <Sparkles size={14} aria-hidden />,
    active
  };
}

export function AiAssistantPanel({
  width,
  accountId,
  projectId,
  locale,
  workspacePort,
  t
}: {
  width: number;
  accountId: string | null;
  projectId: string;
  locale: UiLocale;
  workspacePort: AiWorkspaceToolPort;
  t: Translator;
}) {
  return (
    <Suspense
      fallback={
        <aside className="panel panel-right panel-assistant" style={{ width }}>
          <div className="panel-header"><h2>{t("workspace.assistant")}</h2></div>
          <p className="ai-transcript-empty">{t("common.loading")}</p>
        </aside>
      }
    >
      <AssistantPanel
        width={width}
        accountId={accountId}
        projectId={projectId}
        locale={locale}
        workspacePort={workspacePort}
        t={t}
      />
    </Suspense>
  );
}

export { AI_ASSISTANT_PANEL_ID };
export {
  createAiWorkspacePort,
  type AiWorkspaceCandidateCompileResult,
  type AiWorkspacePortOptions,
  type AiWorkspaceToolSource
} from "@/pages/workspace/assistantWorkspacePort";
export { compileWorkspaceCandidate } from "@/pages/workspace/candidateCompilation";
export { compileWorldWithCandidateDocument } from "@/pages/workspace/compileWorld";
export type {
  AiWorkspaceContextSnapshot,
  AiWorkspaceToolPort
} from "@/features/ai/toolContract";
export {
  AssistantEditReviewCoordinator,
  type AssistantEditProposal,
  type AssistantEditReviewDecision
} from "@/pages/workspace/assistantEditReview";
export { AssistantEditReviewPane } from "@/pages/workspace/components/AssistantEditReviewPane";
