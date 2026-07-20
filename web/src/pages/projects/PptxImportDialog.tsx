import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { UiButton, UiDialog, UiInput, UiSelect } from "@/components/ui";
import type { PptxConversionMode } from "@/lib/api";
import type { Translator } from "@/lib/i18n";
import { processingCapabilityReasonLabel } from "@/pages/processing/model";

const PPTX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export function PptxImportDialog({
  open,
  state,
  reason,
  pending,
  error,
  onClose,
  onSubmit,
  t
}: {
  open: boolean;
  state: "available" | "waiting" | "loading" | "error";
  reason: string | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (file: File, mode: PptxConversionMode) => Promise<unknown>;
  t: Translator;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<PptxConversionMode>("editable");

  useEffect(() => {
    if (!open) {
      setFile(null);
      setMode("editable");
    }
  }, [open]);

  async function submit() {
    if (!file) return;
    try {
      await onSubmit(file, mode);
      onClose();
    } catch {
      // The mutation exposes its localized API error in the dialog.
    }
  }

  return (
    <UiDialog
      open={open}
      title={t("processing.importPptxTitle")}
      description={t("processing.importPptxDescription")}
      onClose={onClose}
      actions={
        <>
          <UiButton onClick={onClose}>{t("common.cancel")}</UiButton>
          <UiButton
            variant="primary"
            disabled={!file || pending || state === "loading" || state === "error"}
            onClick={() => void submit()}
          >
            {pending && <LoaderCircle className="spin" size={15} aria-hidden />}
            {pending ? t("processing.submitting") : t("processing.importPptxAction")}
          </UiButton>
        </>
      }
    >
      <div nve-layout="column gap:md">
        <UiInput
          type="file"
          label={t("processing.pptxFile")}
          accept={`.pptx,${PPTX_MEDIA_TYPE}`}
          onChange={(event) => setFile(event.target.files?.item(0) ?? null)}
        />
        <UiSelect
          label={t("processing.conversionMode")}
          value={mode}
          onChange={(event) =>
            setMode(event.target.value === "fidelity" ? "fidelity" : "editable")
          }
        >
          <option value="editable">{t("processing.mode.editable")}</option>
          <option value="fidelity">{t("processing.mode.fidelity")}</option>
        </UiSelect>
        <span nve-text="label muted">
          {mode === "editable"
            ? t("processing.mode.editableHint")
            : t("processing.mode.fidelityHint")}
        </span>
        {state === "waiting" && (
          <nve-alert status="pending">
            <span>{processingCapabilityReasonLabel(reason, t)}</span>
          </nve-alert>
        )}
        {error && (
          <nve-alert status="danger" role="alert">
            <strong>{t("processing.submitFailed")}</strong>
            <span>{error}</span>
          </nve-alert>
        )}
      </div>
    </UiDialog>
  );
}
