import type { AiRuntimeLocale } from "@/features/ai/protocol";

export type AiRuntimeStatusMessage =
  | "handshaking"
  | "ready"
  | "readyAfterCancellation"
  | "running"
  | "streaming"
  | "invalidHostMessage";

type AiRuntimeMessages = {
  label: string;
  status: Record<AiRuntimeStatusMessage, string>;
  fakeResponse: readonly [string, string];
  errors: {
    turnInProgress: string;
    invalidHostMessage: string;
    providerNotImplemented: string;
  };
};

const messages: Record<AiRuntimeLocale, AiRuntimeMessages> = {
  en: {
    label: "Isolated browser Runtime",
    status: {
      handshaking: "Completing secure handshake…",
      ready: "Ready · fake provider · no credential accepted",
      readyAfterCancellation: "Ready · previous turn cancelled",
      running: "Running deterministic fake provider…",
      streaming: "Streaming deterministic fake response…",
      invalidHostMessage: "Rejected an invalid host message"
    },
    fakeResponse: [
      "The isolated Runtime received this turn. ",
      "The deterministic fake provider completed without network access."
    ],
    errors: {
      turnInProgress: "Another agent turn is already active.",
      invalidHostMessage: "The host sent an invalid Runtime message.",
      providerNotImplemented: "Provider execution is not implemented yet."
    }
  },
  "zh-CN": {
    label: "隔离的浏览器 Runtime",
    status: {
      handshaking: "正在完成安全握手……",
      ready: "就绪 · 模拟 Provider · 未接收凭据",
      readyAfterCancellation: "就绪 · 上一轮已取消",
      running: "正在运行确定性模拟 Provider……",
      streaming: "正在流式返回模拟响应……",
      invalidHostMessage: "已拒绝无效的宿主消息"
    },
    fakeResponse: [
      "隔离 Runtime 已收到本轮消息。",
      "确定性模拟 Provider 已在不访问网络的情况下完成响应。"
    ],
    errors: {
      turnInProgress: "另一轮 Agent 调用仍在进行中。",
      invalidHostMessage: "宿主发送了无效的 Runtime 消息。",
      providerNotImplemented: "Provider 执行尚未实现。"
    }
  }
};

export function aiRuntimeMessages(locale: AiRuntimeLocale) {
  return messages[locale];
}
