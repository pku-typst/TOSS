import { AuthForm } from "@/components/AuthForm";
import { UiButton, UiDialog, UiInput } from "@/components/ui";
import type { AuthConfig } from "@/lib/api";
import type { ContextMenuState, PathDialogState } from "@/pages/workspace/types";
import type { ProjectCopyDialogState } from "@/types/project-ui";
import type { Translator } from "@/lib/i18n";

export function WorkspaceOverlays({
  contextMenu,
  canWrite,
  onAddPath,
  onUploadFromPicker,
  onRenamePath,
  onRemovePath,
  copyDialog,
  copyBusy,
  onCloseCopyDialog,
  onCreateProjectFromTemplate,
  onChangeCopyName,
  pathDialog,
  onClosePathDialog,
  onSubmitPathDialog,
  onChangePathDialogValue,
  authModalOpen,
  canRequestGuestWrite,
  projectName,
  isAnonymousShareTemplate,
  guestNameInput,
  onChangeGuestNameInput,
  onBeginTemporaryGuestEditing,
  authConfig,
  onSignedIn,
  guestAuthError,
  guestAuthPending,
  onCloseAuthModal,
  t
}: {
  contextMenu: ContextMenuState | null;
  canWrite: boolean;
  onAddPath: (kind: "file" | "directory", parentPath?: string) => void;
  onUploadFromPicker: (parentPath?: string) => void;
  onRenamePath: (path: string) => void;
  onRemovePath: (path: string) => void;
  copyDialog: ProjectCopyDialogState | null;
  copyBusy: boolean;
  onCloseCopyDialog: () => void;
  onCreateProjectFromTemplate: () => void;
  onChangeCopyName: (name: string) => void;
  pathDialog: PathDialogState | null;
  onClosePathDialog: () => void;
  onSubmitPathDialog: () => void;
  onChangePathDialogValue: (value: string) => void;
  authModalOpen: boolean;
  canRequestGuestWrite: boolean;
  projectName: string;
  isAnonymousShareTemplate: boolean;
  guestNameInput: string;
  onChangeGuestNameInput: (value: string) => void;
  onBeginTemporaryGuestEditing: () => void;
  authConfig: AuthConfig | null;
  onSignedIn: () => Promise<void>;
  guestAuthError: string | null;
  guestAuthPending: boolean;
  onCloseAuthModal: () => void;
  t: Translator;
}) {
  return (
    <>
      {contextMenu && canWrite && (
        <div className="context-menu-floating" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <nve-menu className="context-menu">
            {contextMenu.kind === "directory" && (
              <nve-menu-item role="menuitem" onClick={() => onAddPath("file", contextMenu.path)}>
                {t("workspace.newFile")}
              </nve-menu-item>
            )}
            {contextMenu.kind === "directory" && (
              <nve-menu-item role="menuitem" onClick={() => onAddPath("directory", contextMenu.path)}>
                {t("workspace.newFolder")}
              </nve-menu-item>
            )}
            {contextMenu.kind === "directory" && (
              <nve-menu-item role="menuitem" onClick={() => onUploadFromPicker(contextMenu.path)}>
                {t("workspace.upload")}
              </nve-menu-item>
            )}
            <nve-menu-item role="menuitem" onClick={() => onRenamePath(contextMenu.path)}>
              {t("common.rename")}
            </nve-menu-item>
            <nve-menu-item role="menuitem" status="danger" onClick={() => onRemovePath(contextMenu.path)}>
              {t("common.delete")}
            </nve-menu-item>
          </nve-menu>
        </div>
      )}

      <UiDialog
        open={!!copyDialog}
        title={t("projects.copyDialogTitle")}
        description={copyDialog ? `${t("projects.copyDialogHint")} ${copyDialog.sourceName}` : undefined}
        onClose={onCloseCopyDialog}
        actions={
          <>
            <UiButton onClick={onCloseCopyDialog}>{t("common.cancel")}</UiButton>
            <UiButton
              variant="primary"
              onClick={onCreateProjectFromTemplate}
              disabled={copyBusy || !copyDialog?.suggestedName.trim()}
            >
              {copyBusy ? t("projects.copying") : t("projects.copyAction")}
            </UiButton>
          </>
        }
      >
        <UiInput
          value={copyDialog?.suggestedName ?? ""}
          onChange={(event) => onChangeCopyName(event.target.value)}
          placeholder={t("projects.namePlaceholder")}
        />
      </UiDialog>

      <UiDialog
        open={!!pathDialog}
        title={
          pathDialog?.mode === "create"
            ? pathDialog.kind === "file"
              ? t("workspace.newFile")
              : t("workspace.newFolder")
            : pathDialog?.mode === "rename"
              ? t("common.rename")
              : t("common.delete")
        }
        description={pathDialog?.mode === "delete" ? `${t("settings.deletePathConfirm")} ${pathDialog.path}` : undefined}
        onClose={onClosePathDialog}
        actions={
          <>
            <UiButton onClick={onClosePathDialog}>{t("common.cancel")}</UiButton>
            <UiButton
              variant={pathDialog?.mode === "delete" ? "danger" : "primary"}
              onClick={onSubmitPathDialog}
              disabled={!!pathDialog && pathDialog.mode !== "delete" && !pathDialog.value.trim()}
            >
              {pathDialog?.mode === "delete" ? t("common.delete") : t("common.save")}
            </UiButton>
          </>
        }
      >
        {pathDialog && pathDialog.mode !== "delete" && (
          <UiInput
            value={pathDialog.value}
            onChange={(event) => onChangePathDialogValue(event.target.value)}
            placeholder={t("workspace.pathPlaceholder")}
          />
        )}
      </UiDialog>

      <UiDialog
        open={authModalOpen}
        title={canRequestGuestWrite ? t("share.guestEditTitle") : t("auth.signIn")}
        description={
          canRequestGuestWrite
            ? t("share.guestEditDescription", { name: projectName })
            : isAnonymousShareTemplate
              ? t("share.templateSavePrompt", { name: projectName })
              : t("share.savePrompt")
        }
        onClose={onCloseAuthModal}
      >
        {canRequestGuestWrite && (
          <div className="auth-fields">
            <UiInput
              value={guestNameInput}
              onChange={(event) => onChangeGuestNameInput(event.target.value)}
              placeholder={t("share.yourName")}
            />
            <UiButton
              variant="primary"
              onClick={onBeginTemporaryGuestEditing}
              disabled={guestAuthPending || !guestNameInput.trim()}
            >
              {guestAuthPending ? t("common.loading") : t("share.startGuestEdit")}
            </UiButton>
            <div className="auth-divider">
              <span>{t("share.orLogin")}</span>
            </div>
          </div>
        )}
        <AuthForm config={authConfig} t={t} compact onSignedIn={onSignedIn} />
        {guestAuthError && <div className="error">{guestAuthError}</div>}
      </UiDialog>
    </>
  );
}
