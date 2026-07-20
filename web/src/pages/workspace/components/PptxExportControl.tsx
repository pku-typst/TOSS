import { useState } from "react";
import { LoaderCircle, Presentation } from "lucide-react";
import { UiButton, UiDialog, UiIconButton, UiSelect } from "@/components/ui";
import type { PptxConversionMode } from "@/lib/api";
import type { Translator } from "@/lib/i18n";
import { processingCapabilityReasonLabel } from "@/pages/processing/model";

export type PptxExportAction = {
  visible: boolean;
  state: "available" | "waiting" | "inapplicable" | "loading" | "error";
  reason: string | null;
  submit: (mode: PptxConversionMode) => Promise<unknown>;
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
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PptxConversionMode>("fidelity");
  if (!action.visible) return null;

  const unavailable = ["inapplicable", "loading", "error"].includes(action.state);
  const label = action.pending
    ? t("processing.submitting")
    : action.state === "waiting"
      ? t("processing.exportPptxWaiting")
      : unavailable
        ? processingCapabilityReasonLabel(action.reason, t)
        : t("processing.exportPptx");

  async function submit() {
    try {
      await action.submit(mode);
      setOpen(false);
    } catch {
      // The mutation exposes its localized API error in the dialog.
    }
  }

  return (
    <>
      <UiIconButton
        tooltip={label}
        label={label}
        disabled={action.pending || unavailable}
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        {action.pending ? (
          <LoaderCircle className="spin" size={16} aria-hidden />
        ) : (
          <Presentation size={16} aria-hidden />
        )}
      </UiIconButton>
      <UiDialog
        open={open}
        title={t("processing.exportPptxTitle")}
        description={t("processing.exportPptxDescription")}
        onClose={() => setOpen(false)}
        actions={
          <>
            <UiButton onClick={() => setOpen(false)}>{t("common.cancel")}</UiButton>
            <UiButton
              variant="primary"
              disabled={action.pending || unavailable}
              onClick={() => void submit()}
            >
              {action.pending && <LoaderCircle className="spin" size={15} aria-hidden />}
              {action.pending ? t("processing.submitting") : t("processing.exportPptxAction")}
            </UiButton>
          </>
        }
      >
        <div nve-layout="column gap:md">
          <UiSelect
            label={t("processing.conversionMode")}
            value={mode}
            onChange={(event) =>
              setMode(event.target.value === "editable" ? "editable" : "fidelity")
            }
          >
            <option value="fidelity">{t("processing.mode.fidelity")}</option>
            <option value="editable">{t("processing.mode.editable")}</option>
          </UiSelect>
          <span nve-text="label muted">
            {mode === "fidelity"
              ? t("processing.mode.fidelityHint")
              : t("processing.mode.editableHint")}
          </span>
          {action.state === "waiting" && (
            <nve-alert status="pending">
              <span>{processingCapabilityReasonLabel(action.reason, t)}</span>
            </nve-alert>
          )}
          {action.error && (
            <nve-alert status="danger" role="alert">
              <strong>{t("processing.submitFailed")}</strong>
              <span>{action.error}</span>
            </nve-alert>
          )}
        </div>
      </UiDialog>
    </>
  );
}
