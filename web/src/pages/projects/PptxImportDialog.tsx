import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { UiButton, UiDialog, UiInput, UiSelect } from "@/components/ui";
import type { ProcessingInputProfileSelector } from "@/lib/api";
import { localizedText } from "@/lib/experience";
import type { Translator, UiLocale } from "@/lib/i18n";
import { processingCapabilityReasonLabel } from "@/pages/processing/model";

const PPTX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export function PptxImportDialog({
  open,
  state,
  reason,
  pending,
  error,
  inputProfileSelector,
  locale,
  onClose,
  onSubmit,
  t
}: {
  open: boolean;
  state: "available" | "waiting" | "loading" | "error";
  reason: string | null;
  pending: boolean;
  error: string | null;
  inputProfileSelector: ProcessingInputProfileSelector | null;
  locale: UiLocale;
  onClose: () => void;
  onSubmit: (file: File, inputProfile: string | null) => Promise<unknown>;
  t: Translator;
}) {
  const [file, setFile] = useState<File | null>(null);
  const initialProfile = inputProfileSelector?.default_profile ?? null;
  const [inputProfile, setInputProfile] = useState<string | null>(initialProfile);
  const selectedProfile = inputProfileSelector?.profiles.find(
    (profile) => profile.id === inputProfile
  );

  useEffect(() => {
    if (!open) {
      setFile(null);
    }
    setInputProfile(initialProfile);
  }, [initialProfile, open]);

  async function submit() {
    if (!file) return;
    try {
      await onSubmit(file, inputProfile);
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
        {inputProfileSelector && inputProfileSelector.profiles.length > 1 && (
          <>
            <UiSelect
              label={localizedText(inputProfileSelector.label, locale)}
              value={inputProfile ?? ""}
              onChange={(event) => setInputProfile(event.target.value)}
            >
              {inputProfileSelector.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {localizedText(profile.label, locale)}
                </option>
              ))}
            </UiSelect>
            {selectedProfile && (
              <span nve-text="label muted">
                {localizedText(selectedProfile.description, locale)}
              </span>
            )}
          </>
        )}
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
