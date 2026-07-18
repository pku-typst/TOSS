import { useRuntimeCollaborationBackend } from "@/composition/applicationRuntime";
import type { OpenProjectRealtime } from "@/pages/workspace/projectRealtimeActor";
import type { OpenRealtimeDocumentSession } from "@/pages/workspace/realtimeDocumentActor";

export interface CollaborationBackend {
  openProject: OpenProjectRealtime;
  openDocument: OpenRealtimeDocumentSession;
}

export function useCollaborationBackend(): CollaborationBackend {
  return useRuntimeCollaborationBackend();
}
