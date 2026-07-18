import { createContext, useContext, type ReactNode } from "react";
import type { CollaborationBackend } from "@/collaboration/collaborationBackend";
import type { CompilationEnvironment } from "@/compilation/compilationEnvironment";
import type { ProjectCatalog } from "@/projects/projectCatalog";
import type { TemplateCatalog } from "@/templates/templateCatalog";
import type { WorkspaceBackend } from "@/workspace/workspaceBackend";

export type ApplicationRuntime = {
  projects: ProjectCatalog;
  templates: TemplateCatalog;
  workspace: WorkspaceBackend;
  collaboration: CollaborationBackend;
  compilation: CompilationEnvironment;
};

const ApplicationRuntimeContext = createContext<ApplicationRuntime | null>(null);

export function ApplicationRuntimeProvider({
  runtime,
  children,
}: {
  runtime: ApplicationRuntime;
  children: ReactNode;
}) {
  return (
    <ApplicationRuntimeContext.Provider value={runtime}>
      {children}
    </ApplicationRuntimeContext.Provider>
  );
}

function useApplicationRuntime() {
  const runtime = useContext(ApplicationRuntimeContext);
  if (!runtime) throw new Error("application_runtime_missing");
  return runtime;
}

export function useRuntimeProjectCatalog() {
  return useApplicationRuntime().projects;
}

export function useRuntimeTemplateCatalog() {
  return useApplicationRuntime().templates;
}

export function useRuntimeWorkspaceBackend() {
  return useApplicationRuntime().workspace;
}

export function useRuntimeCollaborationBackend() {
  return useApplicationRuntime().collaboration;
}

export function useRuntimeCompilationEnvironment() {
  return useApplicationRuntime().compilation;
}
