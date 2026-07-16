import {
  createAssistantMessageEventStream,
  EventStream,
  validateToolArguments,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions
} from "@earendil-works/pi-ai";

export { EventStream, validateToolArguments };

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};

// pi-agent-core 0.80.x still imports its legacy default stream from the pi-ai
// compatibility entrypoint. TOSS always injects an explicitly selected stream.
// Keep an inert fallback so a missed injection fails without registering the
// all-provider catalog in the credential-holding Runtime.
export function streamSimple(
  model: Model<Api>,
  _context: Context,
  _options?: SimpleStreamOptions
) {
  const stream = createAssistantMessageEventStream();
  const error: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason: "error",
    errorMessage: "ai_runtime_stream_not_injected",
    timestamp: Date.now()
  };
  queueMicrotask(() => {
    stream.push({ type: "error", reason: "error", error });
    stream.end();
  });
  return stream;
}
