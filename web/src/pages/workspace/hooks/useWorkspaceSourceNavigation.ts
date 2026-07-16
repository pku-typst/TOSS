import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from "react";
import {
  resolveTypstDocumentToSource,
  resolveTypstSourceToDocument,
  type CompileDiagnostic
} from "@/lib/typst";
import {
  sourceByteOffsetToEditorPosition,
  utf16OffsetToUtf8ByteOffset,
  type TypstDocumentPosition
} from "@/lib/typstSync";
import type { TypstMappingState } from "@/pages/workspace/hooks/useWorkspaceCompilation";
import type { CompileWorld } from "@/pages/workspace/compileWorld";
import type { WorkspacePanelView } from "@/pages/workspace/types";
import type { WorkspaceSessionActor } from "@/pages/workspace/workspaceSessionActor";
import { expandAncestors, normalizePath } from "@/pages/workspace/utils";

type EditorJumpTarget = {
  line: number;
  column: number;
  token: number;
};

type QueuedEditorJump = Omit<EditorJumpTarget, "token"> & {
  path: string;
};

type EditorSourcePosition = {
  line: number;
  column: number;
  offset: number;
};

type UseWorkspaceSourceNavigationInput = {
  activePath: string;
  sessionGeneration: string;
  sessionActor: WorkspaceSessionActor;
  world: CompileWorld;
  mappingRef: RefObject<TypstMappingState | null>;
  singlePanelMode: boolean;
  selectCompactPanel: (view: WorkspacePanelView) => void;
  selectActivePath: (path: string) => void;
  setExpandedDirs: Dispatch<SetStateAction<Set<string>>>;
};

export function useWorkspaceSourceNavigation(
  input: UseWorkspaceSourceNavigationInput
) {
  const sourceToPreviewSequenceRef = useRef(0);
  const previewToSourceSequenceRef = useRef(0);
  const [jumpTarget, setJumpTarget] = useState<EditorJumpTarget | null>(null);
  const [queuedJump, setQueuedJump] = useState<QueuedEditorJump | null>(null);

  useEffect(() => {
    sourceToPreviewSequenceRef.current += 1;
    previewToSourceSequenceRef.current += 1;
    setJumpTarget(null);
    setQueuedJump(null);
  }, [input.sessionGeneration]);

  useEffect(() => {
    if (!queuedJump || queuedJump.path !== input.activePath) return;
    setJumpTarget({
      line: queuedJump.line,
      column: queuedJump.column,
      token: Date.now()
    });
    setQueuedJump(null);
  }, [input.activePath, queuedJump]);

  function revealEditorPosition(
    path: string,
    line: number,
    column: number,
    switchToEditor: boolean
  ) {
    input.setExpandedDirs((previous) => expandAncestors(path, previous));
    if (switchToEditor && input.singlePanelMode) {
      input.selectCompactPanel("editor");
    }
    if (path !== input.sessionActor.getSnapshot().context.activePath) {
      setQueuedJump({ path, line, column });
      input.selectActivePath(path);
      return;
    }
    setJumpTarget({ line, column, token: Date.now() });
  }

  async function resolveSourceClickToPreview(
    position: EditorSourcePosition,
    preferredPageOffset: number
  ): Promise<TypstDocumentPosition | null> {
    const mapping = input.mappingRef.current;
    const sessionGeneration = input.sessionGeneration;
    const path = normalizePath(
      input.sessionActor.getSnapshot().context.activePath,
    );
    if (
      input.world.projectType !== "typst" ||
      !mapping ||
      mapping.world !== input.world ||
      !/\.typ$/i.test(path)
    ) {
      return null;
    }
    const source = mapping.world.source(path);
    if (source === undefined) return null;
    const requestSequence = sourceToPreviewSequenceRef.current + 1;
    sourceToPreviewSequenceRef.current = requestSequence;
    const positions = await resolveTypstSourceToDocument({
      workspaceKey: mapping.world.scope,
      expectedRevision: mapping.revision,
      position: {
        path: `/${path}`,
        byteOffset: utf16OffsetToUtf8ByteOffset(source, position.offset)
      }
    });
    const currentMapping = input.mappingRef.current;
    if (
      requestSequence !== sourceToPreviewSequenceRef.current ||
      input.sessionActor.getSnapshot().context.scope.generation !==
        sessionGeneration ||
      !positions?.length ||
      !currentMapping ||
      currentMapping !== mapping
    ) {
      return null;
    }
    return (
      positions.find((candidate) => candidate.pageOffset === preferredPageOffset) ??
      positions[0] ??
      null
    );
  }

  async function handlePreviewPositionClick(
    position: TypstDocumentPosition,
    renderedMappingRevision: number | null
  ) {
    const mapping = input.mappingRef.current;
    const sessionGeneration = input.sessionGeneration;
    if (
      input.world.projectType !== "typst" ||
      !mapping ||
      mapping.revision !== renderedMappingRevision ||
      mapping.world !== input.world
    ) {
      return;
    }
    const requestSequence = previewToSourceSequenceRef.current + 1;
    previewToSourceSequenceRef.current = requestSequence;
    const location = await resolveTypstDocumentToSource({
      workspaceKey: mapping.world.scope,
      expectedRevision: mapping.revision,
      position
    });
    const currentMapping = input.mappingRef.current;
    if (
      requestSequence !== previewToSourceSequenceRef.current ||
      input.sessionActor.getSnapshot().context.scope.generation !==
        sessionGeneration ||
      !location ||
      location.package ||
      !currentMapping ||
      currentMapping !== mapping
    ) {
      return;
    }
    const path = normalizePath(location.path);
    const source = mapping.world.source(path);
    if (!path || source === undefined) return;
    const editorPosition = sourceByteOffsetToEditorPosition(
      source,
      location.byteOffset
    );
    revealEditorPosition(
      path,
      editorPosition.line,
      editorPosition.column,
      true
    );
  }

  function jumpToDiagnostic(diagnostic: CompileDiagnostic) {
    const path = normalizePath(diagnostic.path || input.activePath);
    const line = Math.max(1, diagnostic.line ?? 1);
    const column = Math.max(1, diagnostic.column ?? 1);
    if (!path) {
      setJumpTarget({ line, column, token: Date.now() });
      return;
    }
    revealEditorPosition(path, line, column, false);
  }

  return {
    jumpTarget,
    clearJumpTarget: () => setJumpTarget(null),
    resolveSourceClickToPreview,
    handlePreviewPositionClick,
    jumpToDiagnostic
  };
}
