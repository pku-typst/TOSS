import { LoaderCircle, Presentation } from "lucide-react";
import { UiIconButton } from "@/components/ui";
import type { Translator } from "@/lib/i18n";
import { processingCapabilityReasonLabel } from "@/pages/processing/model";

export type PptxExportAction = {
  visible: boolean;
  state: "available" | "waiting" | "loading" | "error";
  reason: string | null;
  submit: () => Promise<unknown>;
  pending: boolean;
  error: string | null;
  reset: () => void;
};

export function PptxExportControl({
  action,
  t
}: {
  action: PptxExportAction;
  t: Translator;
}) {
  if (!action.visible) return null;

  const unavailable = ["loading", "error"].includes(action.state);
  const label = action.pending
    ? t("processing.submitting")
    : action.state === "waiting"
      ? t("processing.exportPptxWaiting")
      : unavailable
        ? processingCapabilityReasonLabel(action.reason, t)
        : t("processing.exportPptx");

  return (
    <UiIconButton
      tooltip={label}
      label={label}
      disabled={action.pending || unavailable}
      onClick={() => {
        action.reset();
        void action.submit().catch(() => undefined);
      }}
    >
      {action.pending ? (
        <LoaderCircle className="spin" size={16} aria-hidden />
      ) : (
        <Presentation size={16} aria-hidden />
      )}
    </UiIconButton>
  );
}
