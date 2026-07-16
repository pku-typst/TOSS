import {
  estimateTokens,
  type AgentMessage,
  type AgentTool
} from "@earendil-works/pi-agent-core";

const CHARS_PER_TOKEN = 4;
const COMPACTED_ARGUMENT = "[omitted from older tool history; call the tool again if needed]";

export type AiContextTransformOptions = {
  messages: readonly AgentMessage[];
  systemPrompt: string;
  tools: readonly AgentTool[];
  contextWindow: number;
  maxOutputTokens: number;
  safetyTokens: number;
};

export type AiContextTransformResult = {
  messages: AgentMessage[];
  contextTokens: number;
  inputBudgetTokens: number;
  compactedMessages: number;
  overflow: boolean;
};

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function estimateTextTokens(text: string) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateRuntimeOverhead(systemPrompt: string, tools: readonly AgentTool[]) {
  const schemas = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
  return estimateTextTokens(systemPrompt) + estimateTextTokens(safeJson(schemas));
}

function estimateFreshContext(messages: readonly AgentMessage[], overheadTokens: number) {
  return overheadTokens + messages.reduce((total, message) => total + estimateTokens(message), 0);
}

function hasToolCall(message: AgentMessage) {
  return message.role === "assistant" && message.content.some((part) => part.type === "toolCall");
}

function compactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 256 ? COMPACTED_ARGUMENT : value;
  }
  if (Array.isArray(value)) return value.map(compactValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, compactValue(entry)])
  );
}

function compactToolHistoryMessage(message: AgentMessage): AgentMessage {
  if (message.role === "toolResult") {
    return {
      ...message,
      content: [{
        type: "text",
        text: safeJson({
          context_compacted: true,
          tool: message.toolName
        })
      }],
      details: undefined
    };
  }
  if (!hasToolCall(message) || message.role !== "assistant") return message;
  return {
    ...message,
    content: message.content.flatMap((part) => {
      if (part.type !== "toolCall") return [];
      return [{
        ...part,
        arguments: compactValue(part.arguments) as Record<string, unknown>
      }];
    })
  };
}

function latestToolBatchStart(messages: readonly AgentMessage[], currentTurnStart: number) {
  let sawTrailingToolResult = false;
  for (let index = messages.length - 1; index > currentTurnStart; index -= 1) {
    const message = messages[index];
    if (message.role === "toolResult") {
      sawTrailingToolResult = true;
      continue;
    }
    if (sawTrailingToolResult && hasToolCall(message)) return index;
    break;
  }
  return messages.length;
}

export function transformAgentContext(
  options: AiContextTransformOptions
): AiContextTransformResult {
  const original = [...options.messages];
  const inputBudgetTokens = Math.max(
    0,
    options.contextWindow - options.maxOutputTokens - options.safetyTokens
  );
  const overheadTokens = estimateRuntimeOverhead(options.systemPrompt, options.tools);
  // Agent state intentionally keeps the canonical, unmodified transcript. A previous
  // transform may therefore have omitted messages that a later provider usage block
  // never saw. Re-estimate the raw candidate every time so omitted history cannot be
  // accidentally reintroduced on the next model call.
  const originalContextTokens = estimateFreshContext(original, overheadTokens);
  if (originalContextTokens <= inputBudgetTokens) {
    return {
      messages: original,
      contextTokens: originalContextTokens,
      inputBudgetTokens,
      compactedMessages: 0,
      overflow: false
    };
  }

  const userIndices = original.flatMap((message, index) => message.role === "user" ? [index] : []);
  let messages = original;
  let droppedMessages = 0;
  for (let index = 1; index < userIndices.length; index += 1) {
    const nextStart = userIndices[index];
    messages = original.slice(nextStart);
    droppedMessages = nextStart;
    if (estimateFreshContext(messages, overheadTokens) <= inputBudgetTokens) break;
  }

  let contextTokens = estimateFreshContext(messages, overheadTokens);
  let compactedToolMessages = 0;
  if (contextTokens > inputBudgetTokens) {
    let currentTurnStart = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "user") {
        currentTurnStart = index;
        break;
      }
    }
    const protectedStart = latestToolBatchStart(messages, currentTurnStart);
    const transformed = [...messages];
    for (let index = Math.max(0, currentTurnStart + 1); index < protectedStart; index += 1) {
      const current = transformed[index];
      if (current.role !== "toolResult" && !hasToolCall(current)) continue;
      const compacted = compactToolHistoryMessage(current);
      if (estimateTokens(compacted) >= estimateTokens(current)) continue;
      transformed[index] = compacted;
      compactedToolMessages += 1;
      contextTokens = estimateFreshContext(transformed, overheadTokens);
      if (contextTokens <= inputBudgetTokens) break;
    }
    messages = transformed;
  }

  contextTokens = estimateFreshContext(messages, overheadTokens);
  return {
    messages,
    contextTokens,
    inputBudgetTokens,
    compactedMessages: droppedMessages + compactedToolMessages,
    overflow: contextTokens > inputBudgetTokens
  };
}
