import { useActorRef, useSelector } from "@xstate/react";
import { useEffect, useMemo } from "react";
import {
  projectRealtimeMachine,
  type ProjectRealtimeConfig,
} from "@/pages/workspace/projectRealtimeActor";
import { useCollaborationBackend } from "@/collaboration/collaborationBackend";

export function useProjectRealtime(input: {
  projectId: string;
  workspaceLoaded: boolean;
  effectiveUserId: string;
  shareToken: string | null;
  guestSession: string | null;
}) {
  const collaborationBackend = useCollaborationBackend();
  const actor = useActorRef(projectRealtimeMachine, {
    input: {
      open: collaborationBackend.openProject,
      onProjectReplaced: () => window.location.reload(),
      onAccessChanged: () => window.location.reload(),
    },
  });
  const snapshot = useSelector(actor, (current) => current);
  const config = useMemo<ProjectRealtimeConfig | null>(() => {
    if (!input.projectId || !input.workspaceLoaded) return null;
    return {
      sessionKey: JSON.stringify([
        input.projectId,
        input.effectiveUserId,
        input.shareToken,
        input.guestSession,
      ]),
      projectId: input.projectId,
      userId: input.effectiveUserId,
      shareToken: input.shareToken,
      guestSession: input.guestSession,
    };
  }, [
    input.effectiveUserId,
    input.guestSession,
    input.projectId,
    input.shareToken,
    input.workspaceLoaded,
  ]);

  useEffect(() => {
    if (config) actor.send({ type: "bind", config });
    else actor.send({ type: "disable" });
  }, [actor, config]);

  return {
    status: snapshot.context.status,
    realtimeCatchUpSequence: snapshot.context.catchUpSequence,
    workspaceChangeSequence: snapshot.context.workspaceChangeSequence,
    workspaceStructuralChangeSequence:
      snapshot.context.structuralChangeSequence,
    workspaceDocumentChanges: snapshot.context.documentChanges,
  };
}
