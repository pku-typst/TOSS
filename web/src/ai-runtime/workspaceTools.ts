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
    details: { tool, outcome: "success" as const },
    ...("status" in result && result.status === "review_pending"
      ? { terminate: true as const }
      : {})
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

const inspectCompilationTool = (
  bridge: AiRuntimeToolBridge,
  messages: ToolMessages
): AgentTool => ({
  name: "inspect_compilation",
  label: messages.compilation.label,
  description: messages.compilation.description,
  parameters: Type.Object({}, { additionalProperties: false }),
  executionMode: "parallel",
  execute: async (_toolCallId, parameters, signal) => toolResult(
    "inspect_compilation",
    await bridge.call({
      tool: "inspect_compilation",
      arguments: parameters
    } as AiWorkspaceToolRequest, signal)
  )
});

const listTypstPackageFilesTool = (
  bridge: AiRuntimeToolBridge,
  messages: ToolMessages
): AgentTool => ({
  name: "list_typst_package_files",
  label: messages.packageList.label,
  description: messages.packageList.description,
  parameters: Type.Object({
    package_spec: Type.String({
      description: messages.packageList.packageSpec,
      minLength: 1,
      maxLength: AI_WORKSPACE_TOOL_LIMITS.maxPackageSpecLength
    }),
    path_prefix: Type.Optional(Type.String({
      description: messages.packageList.pathPrefix,
      maxLength: AI_WORKSPACE_TOOL_LIMITS.maxPathLength
    })),
    offset: Type.Optional(Type.Integer({
      description: messages.packageList.offset,
      minimum: 0
    })),
    limit: Type.Optional(Type.Integer({
      description: messages.packageList.limit,
      minimum: 1,
      maximum: AI_WORKSPACE_TOOL_LIMITS.maxListEntries
    }))
  }, { additionalProperties: false }),
  executionMode: "parallel",
  execute: async (_toolCallId, parameters, signal) => toolResult(
    "list_typst_package_files",
    await bridge.call({
      tool: "list_typst_package_files",
      arguments: parameters
    } as AiWorkspaceToolRequest, signal)
  )
});

const readTypstPackageFileTool = (
  bridge: AiRuntimeToolBridge,
  messages: ToolMessages
): AgentTool => ({
  name: "read_typst_package_file",
  label: messages.packageRead.label,
  description: messages.packageRead.description,
  parameters: Type.Object({
    package_spec: Type.String({
      description: messages.packageRead.packageSpec,
      minLength: 1,
      maxLength: AI_WORKSPACE_TOOL_LIMITS.maxPackageSpecLength
    }),
    path: Type.String({
      description: messages.packageRead.path,
      minLength: 1,
      maxLength: AI_WORKSPACE_TOOL_LIMITS.maxPathLength
    }),
    start_line: Type.Optional(Type.Integer({
      description: messages.packageRead.startLine,
      minimum: 1
    })),
    end_line: Type.Optional(Type.Integer({
      description: messages.packageRead.endLine,
      minimum: 1
    }))
  }, { additionalProperties: false }),
  executionMode: "parallel",
  execute: async (_toolCallId, parameters, signal) => toolResult(
    "read_typst_package_file",
    await bridge.call({
      tool: "read_typst_package_file",
      arguments: parameters
    } as AiWorkspaceToolRequest, signal)
  )
});

const searchTypstPackageTextTool = (
  bridge: AiRuntimeToolBridge,
  messages: ToolMessages
): AgentTool => ({
  name: "search_typst_package_text",
  label: messages.packageSearch.label,
  description: messages.packageSearch.description,
  parameters: Type.Object({
    package_spec: Type.String({
      description: messages.packageSearch.packageSpec,
      minLength: 1,
      maxLength: AI_WORKSPACE_TOOL_LIMITS.maxPackageSpecLength
    }),
    query: Type.String({
      description: messages.packageSearch.query,
      minLength: 1,
      maxLength: AI_WORKSPACE_TOOL_LIMITS.maxSearchQueryLength
    }),
    path_prefix: Type.Optional(Type.String({
      description: messages.packageSearch.pathPrefix,
      maxLength: AI_WORKSPACE_TOOL_LIMITS.maxPathLength
    })),
    case_sensitive: Type.Optional(Type.Boolean({
      description: messages.packageSearch.caseSensitive
    })),
    max_results: Type.Optional(Type.Integer({
      description: messages.packageSearch.maxResults,
      minimum: 1,
      maximum: AI_WORKSPACE_TOOL_LIMITS.maxSearchMatches
    }))
  }, { additionalProperties: false }),
  executionMode: "parallel",
  execute: async (_toolCallId, parameters, signal) => toolResult(
    "search_typst_package_text",
    await bridge.call({
      tool: "search_typst_package_text",
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
  inspect_compilation: inspectCompilationTool,
  list_typst_package_files: listTypstPackageFilesTool,
  read_typst_package_file: readTypstPackageFileTool,
  search_typst_package_text: searchTypstPackageTextTool,
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
