import { lazy, Suspense } from "react";
import { Sparkles } from "lucide-react";
import "@/features/ai/styles.css";
import { AI_ASSISTANT_PANEL_ID } from "@/features/ai/protocol";
import type { Translator, UiLocale } from "@/lib/i18n";
import type {
  WorkspaceOptionalPanelDescriptor,
  WorkspaceOptionalSettingsSectionDescriptor
} from "@/pages/workspace/types";
import type {
  AiWorkspaceEditReviewOutcome,
  AiWorkspaceToolPort
} from "@/features/ai/toolContract";
import type { AuthConfig } from "@/lib/api/types";

const AssistantPanel = lazy(() => import("@/features/ai/AssistantPanel"));
const AiSettingsSection = lazy(() => import("@/features/ai/AiSettingsSection"));

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
  editReviewOutcomes,
  aiAssistantConfig,
  onOpenSettings,
  t
}: {
  width: number;
  accountId: string | null;
  projectId: string;
  locale: UiLocale;
  workspacePort: AiWorkspaceToolPort;
  editReviewOutcomes: readonly AiWorkspaceEditReviewOutcome[];
  aiAssistantConfig: AuthConfig["ai_assistant"];
  onOpenSettings: () => void;
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
        editReviewOutcomes={editReviewOutcomes}
        aiAssistantConfig={aiAssistantConfig}
        onOpenSettings={onOpenSettings}
        t={t}
      />
    </Suspense>
  );
}

export function aiAssistantSettingsSection({
  enabled,
  accountId,
  locale,
  aiAssistantConfig,
  t
}: {
  enabled: boolean;
  accountId: string | null;
  locale: UiLocale;
  aiAssistantConfig: AuthConfig["ai_assistant"];
  t: Translator;
}): WorkspaceOptionalSettingsSectionDescriptor | null {
  if (!enabled || !aiAssistantConfig) return null;
  return {
    section: AI_ASSISTANT_PANEL_ID,
    label: t("settings.sectionAssistant"),
    icon: <Sparkles size={15} aria-hidden />,
    content: (
      <Suspense fallback={<p>{t("common.loading")}</p>}>
        <AiSettingsSection
          accountId={accountId}
          locale={locale}
          aiAssistantConfig={aiAssistantConfig}
          t={t}
        />
      </Suspense>
    )
  };
}

export { AI_ASSISTANT_PANEL_ID };
export {
  createAiWorkspacePort,
  type AiWorkspaceCandidateCompileResult,
  type AiWorkspaceCompilationSnapshot,
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
  type AssistantEditReviewDecision,
  type AssistantEditReviewOutcome,
  type AssistantEditReviewRequestResult
} from "@/pages/workspace/assistantEditReview";
export { AssistantEditReviewPane } from "@/pages/workspace/components/AssistantEditReviewPane";
