import { FormEvent, useEffect, useState, useSyncExternalStore } from "react";
import { UiButton } from "@/components/ui";
import { AI_RUNTIME_ENTRY_PATH } from "@/features/ai/protocol";
import { AiRuntimeClient, type AiRuntimeStatus } from "@/features/ai/runtimeClient";
import type { Translator, UiLocale } from "@/lib/i18n";

function statusLabel(status: AiRuntimeStatus, t: Translator) {
  if (status === "handshaking") return t("ai.status.handshaking");
  if (status === "ready") return t("ai.status.ready");
  if (status === "running") return t("ai.status.running");
  if (status === "error") return t("ai.status.error");
  return t("ai.status.starting");
}

function emptyMessageLabel(state: "complete" | "streaming" | "cancelled" | "error", t: Translator) {
  if (state === "cancelled") return t("ai.status.cancelled");
  if (state === "error") return t("ai.status.failed");
  return t("ai.status.running");
}

export default function AssistantPanel({
  width,
  locale,
  t
}: {
  width: number;
  locale: UiLocale;
  t: Translator;
}) {
  const [runtime, setRuntime] = useState(() => ({
    generation: 0,
    client: new AiRuntimeClient(locale)
  }));
  const [draft, setDraft] = useState("");
  const client = runtime.client;
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);

  useEffect(() => () => client.dispose(), [client]);
  useEffect(() => client.setLocale(locale), [client, locale]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (client.startTurn(draft)) setDraft("");
  }

  function restartRuntime() {
    client.dispose();
    setRuntime({
      generation: runtime.generation + 1,
      client: new AiRuntimeClient(locale)
    });
  }

  return (
    <aside className="panel panel-right panel-assistant" style={{ width }}>
      <div className="panel-header">
        <h2>{t("workspace.assistant")}</h2>
        <span className={`ai-runtime-state ai-runtime-state--${snapshot.status}`}>
          {statusLabel(snapshot.status, t)}
        </span>
      </div>
      <div className="ai-runtime-frame-wrap">
        <iframe
          key={runtime.generation}
          className="ai-runtime-frame"
          src={AI_RUNTIME_ENTRY_PATH}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'"
          title={t("ai.runtime.title")}
          onLoad={(event) => client.connect(event.currentTarget)}
        />
      </div>
      <p className="ai-prototype-notice">{t("ai.prototype.notice")}</p>
      <div className="ai-transcript" aria-live="polite">
        {snapshot.messages.length === 0 ? (
          <p className="ai-transcript-empty">{t("ai.empty")}</p>
        ) : (
          snapshot.messages.map((message) => (
            <article
              key={message.id}
              className={`ai-message ai-message--${message.role}`}
              data-state={message.state}
            >
              <strong>{message.role === "user" ? t("ai.role.user") : t("ai.role.assistant")}</strong>
              <p>{message.text || emptyMessageLabel(message.state, t)}</p>
            </article>
          ))
        )}
      </div>
      {snapshot.error && <p className="ai-runtime-error">{t("ai.error", { code: snapshot.error })}</p>}
      <form className="ai-composer" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t("ai.prompt.placeholder")}
          disabled={snapshot.status !== "ready"}
          rows={3}
        />
        <div className="ai-composer-actions">
          {snapshot.status === "error" && (
            <UiButton type="button" onClick={restartRuntime}>
              {t("common.retry")}
            </UiButton>
          )}
          {snapshot.status === "running" ? (
            <UiButton key="cancel-turn" type="button" onClick={() => client.cancelTurn()}>
              {t("common.cancel")}
            </UiButton>
          ) : (
            <UiButton
              key="start-turn"
              type="submit"
              disabled={snapshot.status !== "ready" || !draft.trim()}
            >
              {t("ai.send")}
            </UiButton>
          )}
        </div>
      </form>
    </aside>
  );
}
