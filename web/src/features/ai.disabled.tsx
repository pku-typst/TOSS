import type { Translator, UiLocale } from "@/lib/i18n";
import type { WorkspaceOptionalPanelDescriptor } from "@/pages/workspace/types";

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
  locale: UiLocale;
  t: Translator;
}) {
  return null;
}
