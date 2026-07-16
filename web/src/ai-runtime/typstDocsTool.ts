import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { aiRuntimeToolMessages } from "@/ai-runtime/i18n";
import type { AiRuntimeLocale } from "@/features/ai/protocol";
import type { AiWorkspaceCapabilities } from "@/features/ai/toolContract";
import {
  queryTypstDocs,
  TYPST_DOCS_TOOL_NAME,
  TYPST_DOCS_VERSION,
  type TypstDocsQueryResult
} from "@/ai-runtime/typstDocsSearch";

type TypstDocsToolOptions = {
  onQuery?: (query: string, result: TypstDocsQueryResult) => void;
};

export function createTypstDocsTools(
  capabilities: AiWorkspaceCapabilities | null,
  locale: AiRuntimeLocale = "en",
  options: TypstDocsToolOptions = {}
): AgentTool[] {
  if (capabilities?.project_type !== "typst") return [];
  const messages = aiRuntimeToolMessages(locale).typstDocs;
  const parameters = Type.Object({
    query: Type.String({
      description: messages.query,
      minLength: 1,
      maxLength: 256
    }),
    limit: Type.Optional(Type.Integer({
      description: messages.limit,
      minimum: 1,
      maximum: 8
    }))
  }, { additionalProperties: false });
  const tool: AgentTool<typeof parameters> = {
    name: TYPST_DOCS_TOOL_NAME,
    label: messages.label,
    description: messages.description,
    parameters,
    executionMode: "parallel",
    execute: async (_toolCallId, parameters, signal) => {
      try {
        const result = await queryTypstDocs(parameters.query, parameters.limit, signal);
        options.onQuery?.(parameters.query, result);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: {
            tool: TYPST_DOCS_TOOL_NAME,
            outcome: "success" as const,
            version: TYPST_DOCS_VERSION,
            results: result.results.length
          }
        };
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          throw error;
        }
        throw new Error("typst_docs_unavailable", { cause: error });
      }
    }
  };
  return [tool];
}
