import type { CollaborationBackend } from "@/collaboration/collaborationBackend";
import { openProjectRealtime } from "@/pages/workspace/projectRealtimeActor";
import { openRealtimeDocumentSession } from "@/pages/workspace/realtimeDocumentActor";

export const coreCollaborationBackend: CollaborationBackend = {
  openProject: openProjectRealtime,
  openDocument: openRealtimeDocumentSession,
};
