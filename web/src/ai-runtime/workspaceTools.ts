import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { AiRuntimeToolBridge } from "@/ai-runtime/toolBridge";
import { aiRuntimeToolMessages } from "@/ai-runtime/i18n";
import type { AiRuntimeLocale } from "@/features/ai/protocol";
import {
  AI_WORKSPACE_TOOL_LIMITS,
  type AiWorkspaceCapabilities,
  type AiWorkspaceToolName,
  type AiWorkspaceToolRequest,
  type AiWorkspaceToolResult
} from "@/features/ai/toolContract";

type ToolMessages = ReturnType<typeof aiRuntimeToolMessages>;

function toolResult(tool: AiWorkspaceToolName, result: AiWorkspaceToolResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    details: { tool, outcome: "success" as const }
  };
}

const listProjectFilesTool = (
  bridge: AiRuntimeToolBridge,
  messages: ToolMessages
): AgentTool => ({
  name: "list_project_files",
  label: messages.list.label,
  description: messages.list.description,
  parameters: Type.Object({
    path_prefix: Type.Optional(Type.String({
      description: messages.list.pathPrefix,
      maxLength: AI_WORKSPACE_TOOL_LIMITS.maxPathLength
    })),
    offset: Type.Optional(Type.Integer({
      description: messages.list.offset,
      minimum: 0
    })),
    limit: Type.Optional(Type.Integer({
      description: messages.list.limit,
      minimum: 1,
      maximum: AI_WORKSPACE_TOOL_LIMITS.maxListEntries
    }))
  }, { additionalProperties: false }),
  executionMode: "parallel",
  execute: async (_toolCallId, parameters, signal) => toolResult(
    "list_project_files",
    await bridge.call({
      tool: "list_project_files",
      arguments: parameters
    } as AiWorkspaceToolRequest, signal)
  )
});

const readProjectFileTool = (
  bridge: AiRuntimeToolBridge,
  messages: ToolMessages
): AgentTool => ({
  name: "read_project_file",
  label: messages.read.label,
  description: messages.read.description,
  parameters: Type.Object({
    path: Type.String({
      description: messages.read.path,
      minLength: 1,
      maxLength: AI_WORKSPACE_TOOL_LIMITS.maxPathLength
    }),
    start_line: Type.Optional(Type.Integer({
      description: messages.read.startLine,
      minimum: 1
    })),
    end_line: Type.Optional(Type.Integer({
      description: messages.read.endLine,
      minimum: 1
    }))
  }, { additionalProperties: false }),
  executionMode: "parallel",
  execute: async (_toolCallId, parameters, signal) => toolResult(
    "read_project_file",
    await bridge.call({
      tool: "read_project_file",
      arguments: parameters
    } as AiWorkspaceToolRequest, signal)
  )
});

const searchProjectTextTool = (
  bridge: AiRuntimeToolBridge,
  messages: ToolMessages
): AgentTool => ({
  name: "search_project_text",
  label: messages.search.label,
  description: messages.search.description,
  parameters: Type.Object({
    query: Type.String({
      description: messages.search.query,
      minLength: 1,
      maxLength: AI_WORKSPACE_TOOL_LIMITS.maxSearchQueryLength
    }),
    path_prefix: Type.Optional(Type.String({
      description: messages.search.pathPrefix,
      maxLength: AI_WORKSPACE_TOOL_LIMITS.maxPathLength
    })),
    case_sensitive: Type.Optional(Type.Boolean({
      description: messages.search.caseSensitive
    })),
    max_results: Type.Optional(Type.Integer({
      description: messages.search.maxResults,
      minimum: 1,
      maximum: AI_WORKSPACE_TOOL_LIMITS.maxSearchMatches
    }))
  }, { additionalProperties: false }),
  executionMode: "parallel",
  execute: async (_toolCallId, parameters, signal) => toolResult(
    "search_project_text",
    await bridge.call({
      tool: "search_project_text",
      arguments: parameters
    } as AiWorkspaceToolRequest, signal)
  )
});

const applyPatchTool = (
  bridge: AiRuntimeToolBridge,
  messages: ToolMessages
): AgentTool => ({
  name: "apply_patch",
  label: messages.applyPatch.label,
  description: messages.applyPatch.description,
  parameters: Type.Object({
    path: Type.String({
      description: messages.applyPatch.path,
      minLength: 1,
      maxLength: AI_WORKSPACE_TOOL_LIMITS.maxPathLength
    }),
    base_snapshot: Type.String({
      description: messages.applyPatch.baseSnapshot,
      minLength: 1,
      maxLength: 128
    }),
    patch: Type.String({
      description: messages.applyPatch.patch,
      minLength: 1,
      maxLength: AI_WORKSPACE_TOOL_LIMITS.maxPatchCharacters
    })
  }, { additionalProperties: false }),
  executionMode: "sequential",
  execute: async (_toolCallId, parameters, signal) => toolResult(
    "apply_patch",
    await bridge.call({
      tool: "apply_patch",
      arguments: parameters
    } as AiWorkspaceToolRequest, signal)
  )
});

const writeFileTool = (
  bridge: AiRuntimeToolBridge,
  messages: ToolMessages
): AgentTool => ({
  name: "write_file",
  label: messages.writeFile.label,
  description: messages.writeFile.description,
  parameters: Type.Object({
    path: Type.String({
      description: messages.writeFile.path,
      minLength: 1,
      maxLength: AI_WORKSPACE_TOOL_LIMITS.maxPathLength
    }),
    base_snapshot: Type.String({
      description: messages.writeFile.baseSnapshot,
      minLength: 1,
      maxLength: 128
    }),
    content: Type.String({
      description: messages.writeFile.content,
      minLength: 0,
      maxLength: AI_WORKSPACE_TOOL_LIMITS.maxWriteFileCharacters
    })
  }, { additionalProperties: false }),
  executionMode: "sequential",
  execute: async (_toolCallId, parameters, signal) => toolResult(
    "write_file",
    await bridge.call({
      tool: "write_file",
      arguments: parameters
    } as AiWorkspaceToolRequest, signal)
  )
});

const toolFactories: Record<
  AiWorkspaceToolName,
  (bridge: AiRuntimeToolBridge, messages: ToolMessages) => AgentTool
> = {
  list_project_files: listProjectFilesTool,
  read_project_file: readProjectFileTool,
  search_project_text: searchProjectTextTool,
  apply_patch: applyPatchTool,
  write_file: writeFileTool
};

export function createAiWorkspaceTools(
  capabilities: AiWorkspaceCapabilities | null,
  bridge: AiRuntimeToolBridge,
  locale: AiRuntimeLocale = "en"
) {
  if (!capabilities) return [];
  const messages = aiRuntimeToolMessages(locale);
  return capabilities.tools.map((name) => toolFactories[name](bridge, messages));
}
