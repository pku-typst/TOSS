import { useMemo, type ReactNode } from "react";
import { coreCollaborationBackend } from "@/collaboration/coreCollaborationBackend";
import { createCoreCompilationEnvironment } from "@/compilation/coreCompilationEnvironment";
import {
  ApplicationRuntimeProvider,
  type ApplicationRuntime,
} from "@/composition/applicationRuntime";
import { coreProjectCatalog } from "@/projects/coreProjectCatalog";
import { coreTemplateCatalog } from "@/templates/coreTemplateCatalog";
import { coreWorkspaceBackend } from "@/workspace/coreWorkspaceBackend";

export function CoreBackendProvider({ children }: { children: ReactNode }) {
  const runtime = useMemo<ApplicationRuntime>(
    () => ({
      projects: coreProjectCatalog,
      templates: coreTemplateCatalog,
      workspace: coreWorkspaceBackend,
      collaboration: coreCollaborationBackend,
      compilation: createCoreCompilationEnvironment(),
    }),
    [],
  );
  return (
    <ApplicationRuntimeProvider runtime={runtime}>
      {children}
    </ApplicationRuntimeProvider>
  );
}
