import type { AiRuntimeLocale } from "@/features/ai/protocol";
import type { AiWorkspaceCapabilities } from "@/features/ai/toolContract";
import { AiRuntimeToolBridge } from "@/ai-runtime/toolBridge";
import { preloadTypstDocs } from "@/ai-runtime/typstDocsSearch";
import { createTypstDocsTools } from "@/ai-runtime/typstDocsTool";
import { createAiWorkspaceTools } from "@/ai-runtime/workspaceTools";

export async function prepareAiRuntimeToolResources(
  capabilities: AiWorkspaceCapabilities | null
) {
  if (capabilities?.project_type === "typst") await preloadTypstDocs();
}

export function createAiRuntimeTools(
  capabilities: AiWorkspaceCapabilities | null,
  bridge: AiRuntimeToolBridge,
  locale: AiRuntimeLocale = "en"
) {
  return [
    ...createTypstDocsTools(capabilities, locale),
    ...createAiWorkspaceTools(capabilities, bridge, locale)
  ];
}
