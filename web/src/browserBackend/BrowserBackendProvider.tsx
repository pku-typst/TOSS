import { useEffect, useMemo, type ReactNode } from "react";
import { BrowserWorkspaceEvents } from "@/browserBackend/browserEvents";
import { createBrowserCollaborationBackend } from "@/browserBackend/browserCollaborationBackend";
import { BrowserProjectCatalog } from "@/browserBackend/browserProjectCatalog";
import type {
  BrowserProjectSeed,
  BrowserTemplateDefinition,
} from "@/browserBackend/browserRecords";
import { BrowserTemplateCatalog } from "@/browserBackend/browserTemplateCatalog";
import { createBrowserWorkspaceBackend } from "@/browserBackend/browserWorkspaceBackend";
import { BrowserWorkspaceStore } from "@/browserBackend/browserWorkspaceStore";
import type { CompilationEnvironment } from "@/compilation/compilationEnvironment";
import {
  ApplicationRuntimeProvider,
  type ApplicationRuntime,
} from "@/composition/applicationRuntime";

export type BrowserBackendConfiguration = {
  projectSeeds: Record<"typst" | "latex", BrowserProjectSeed | null>;
  templates: BrowserTemplateDefinition[];
  compilation: CompilationEnvironment;
};

export function BrowserBackendProvider({
  configuration,
  children,
}: {
  configuration: BrowserBackendConfiguration;
  children: ReactNode;
}) {
  const backend = useMemo(() => {
    const events = new BrowserWorkspaceEvents();
    const store = new BrowserWorkspaceStore(events);
    return {
      events,
      runtime: {
        projects: new BrowserProjectCatalog(store, configuration.projectSeeds),
        templates: new BrowserTemplateCatalog(store, configuration.templates),
        workspace: createBrowserWorkspaceBackend(store),
        collaboration: createBrowserCollaborationBackend(store),
        compilation: configuration.compilation,
      } satisfies ApplicationRuntime,
    };
  }, [configuration]);

  useEffect(() => {
    backend.events.open();
    return () => backend.events.close();
  }, [backend]);

  return (
    <ApplicationRuntimeProvider runtime={backend.runtime}>
      {children}
    </ApplicationRuntimeProvider>
  );
}
