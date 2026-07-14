import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import {
  createProjectFile,
  deleteProjectFile,
  downloadProjectArchive,
  moveProjectFile,
  upsertDocumentByPath,
  uploadProjectAsset,
} from "@/lib/api";
import { bytesToBase64 } from "@/lib/base64";
import type { ProjectType } from "@/lib/deploymentCapabilities";
import type { Translator } from "@/lib/i18n";
import {
  collectUploadCandidates,
  type UploadCandidate,
} from "@/pages/workspace/uploads";
import type {
  ContextMenuState,
  PathDialogState,
} from "@/pages/workspace/types";
import {
  isTextFile,
  joinProjectPath,
  normalizePath,
  parentProjectPath,
} from "@/pages/workspace/utils";

type UseWorkspaceFileActionsInput = {
  projectId: string;
  sessionGeneration: string;
  projectName: string;
  projectType: ProjectType;
  contentEpoch: number | null;
  activePath: string;
  entryFilePath: string;
  canWrite: boolean;
  isRevisionMode: boolean;
  selectActivePath: (path: string) => void;
  updateDocumentContent: (path: string, content: string) => void;
  refreshProjectData: () => Promise<void>;
  t: Translator;
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function useWorkspaceFileActions(input: UseWorkspaceFileActionsInput) {
  const [filesDropActive, setFilesDropActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathDialog, setPathDialog] = useState<PathDialogState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const sessionGenerationRef = useRef(input.sessionGeneration);
  sessionGenerationRef.current = input.sessionGeneration;

  useEffect(() => {
    setFilesDropActive(false);
    setError(null);
    setPathDialog(null);
    setContextMenu(null);
  }, [input.sessionGeneration]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".context-menu")) return;
      setContextMenu(null);
    };
    const closeOnScroll = () => setContextMenu(null);
    window.addEventListener("click", closeMenu, true);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      window.removeEventListener("click", closeMenu, true);
      window.removeEventListener("scroll", closeOnScroll, true);
    };
  }, [contextMenu]);

  function requestContextMenu(menu: ContextMenuState) {
    setContextMenu(menu);
  }

  function addPath(kind: "file" | "directory", parentPath = "") {
    if (!input.projectId || !input.canWrite || input.isRevisionMode) return;
    setContextMenu(null);
    const filePlaceholder =
      input.projectType === "latex" ? "untitled.tex" : "untitled.typ";
    setPathDialog({
      mode: "create",
      kind,
      parentPath,
      value: joinProjectPath(
        parentPath,
        kind === "file" ? filePlaceholder : "folder",
      ),
    });
  }

  function renamePath(path: string) {
    if (!input.projectId || !input.canWrite || input.isRevisionMode) return;
    setContextMenu(null);
    setPathDialog({ mode: "rename", path, value: path });
  }

  function removePath(path: string) {
    if (!input.projectId || !input.canWrite || input.isRevisionMode) return;
    setContextMenu(null);
    setPathDialog({ mode: "delete", path });
  }

  async function submitPathDialog() {
    if (
      !input.projectId ||
      !pathDialog ||
      !input.canWrite ||
      input.isRevisionMode
    ) {
      return;
    }
    const operationProjectId = input.projectId;
    const operationGeneration = input.sessionGeneration;
    const operationDialog = pathDialog;
    try {
      setContextMenu(null);
      let nextActivePath: string | null = null;
      if (operationDialog.mode === "create") {
        let normalized = normalizePath(operationDialog.value);
        if (operationDialog.parentPath && !normalized.includes("/")) {
          normalized = joinProjectPath(operationDialog.parentPath, normalized);
        }
        if (!normalized) return;
        await createProjectFile(operationProjectId, {
          path: normalized,
          kind: operationDialog.kind,
          content: operationDialog.kind === "file" ? "" : undefined,
        });
        if (operationDialog.kind === "file") nextActivePath = normalized;
      } else if (operationDialog.mode === "rename") {
        let normalizedTo = normalizePath(operationDialog.value);
        const parentPath = parentProjectPath(operationDialog.path);
        if (parentPath && !normalizedTo.includes("/")) {
          normalizedTo = joinProjectPath(parentPath, normalizedTo);
        }
        if (!normalizedTo || normalizedTo === operationDialog.path) {
          setPathDialog(null);
          return;
        }
        await moveProjectFile(
          operationProjectId,
          operationDialog.path,
          normalizedTo,
        );
        if (input.activePath === operationDialog.path) {
          nextActivePath = normalizedTo;
        }
      } else {
        await deleteProjectFile(operationProjectId, operationDialog.path);
        if (input.activePath === operationDialog.path) {
          nextActivePath = input.entryFilePath;
        }
      }
      if (sessionGenerationRef.current !== operationGeneration) return;
      await input.refreshProjectData();
      if (sessionGenerationRef.current !== operationGeneration) return;
      if (nextActivePath) input.selectActivePath(nextActivePath);
      setPathDialog(null);
      setError(null);
    } catch (error) {
      if (sessionGenerationRef.current !== operationGeneration) return;
      setError(
        errorMessage(error, input.t("errors.updatePath")),
      );
    }
  }

  async function commitUploads(items: UploadCandidate[], parentPath = "") {
    if (
      !input.projectId ||
      items.length === 0 ||
      !input.canWrite ||
      input.isRevisionMode ||
      input.contentEpoch === null
    ) {
      return;
    }
    const operationProjectId = input.projectId;
    const operationGeneration = input.sessionGeneration;
    const operationContentEpoch = input.contentEpoch;
    const remainsCurrent = () =>
      sessionGenerationRef.current === operationGeneration;
    try {
      setContextMenu(null);
      for (const item of items) {
        if (!remainsCurrent()) return;
        const path = normalizePath(
          joinProjectPath(parentPath, item.relativePath || item.file.name),
        );
        const bytes = new Uint8Array(await item.file.arrayBuffer());
        if (!remainsCurrent()) return;
        if (isTextFile(path) || item.file.type.startsWith("text/")) {
          const text = new TextDecoder().decode(bytes);
          await upsertDocumentByPath(
            operationProjectId,
            path,
            text,
            operationContentEpoch,
          );
          input.updateDocumentContent(path, text);
        } else {
          await uploadProjectAsset(operationProjectId, {
            path,
            content_base64: bytesToBase64(bytes),
            content_type: item.file.type || "application/octet-stream",
          });
        }
      }
      if (!remainsCurrent()) return;
      await input.refreshProjectData();
      if (!remainsCurrent()) return;
      setError(null);
    } catch (error) {
      if (!remainsCurrent()) return;
      setError(errorMessage(error, input.t("errors.upload")));
    }
  }

  function uploadFromPicker(parentPath = "") {
    if (!input.canWrite || input.isRevisionMode) return;
    setContextMenu(null);
    const picker = document.createElement("input");
    picker.type = "file";
    picker.multiple = true;
    picker.onchange = async () => {
      const files = Array.from(picker.files || []).map((file) => ({
        relativePath: file.name,
        file,
      }));
      await commitUploads(files, parentPath);
    };
    picker.click();
  }

  async function onTreeDrop(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    setFilesDropActive(false);
    if (!input.canWrite || input.isRevisionMode) return;
    await commitUploads(await collectUploadCandidates(event.dataTransfer));
  }

  async function downloadArchive() {
    if (!input.projectId) return;
    const operationGeneration = input.sessionGeneration;
    setContextMenu(null);
    try {
      const blob = await downloadProjectArchive(input.projectId);
      if (sessionGenerationRef.current !== operationGeneration) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${input.projectName || "project"}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
      setError(null);
    } catch (error) {
      if (sessionGenerationRef.current !== operationGeneration) return;
      setError(
        errorMessage(error, input.t("errors.downloadArchive")),
      );
    }
  }

  return {
    error,
    filesDropActive,
    setFilesDropActive,
    contextMenu,
    requestContextMenu,
    pathDialog,
    setPathDialog,
    addPath,
    renamePath,
    removePath,
    submitPathDialog,
    uploadFromPicker,
    onTreeDrop,
    downloadArchive,
  };
}
