import { UiBadge, UiButton } from "@/components/ui";
import type { Translator } from "@/lib/i18n";
import type { AssistantEditProposal } from "@/pages/workspace/assistantEditReview";

function diffLineClass(line: string) {
  if (line.startsWith("@@ ")) return "ai-edit-review-line--hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "ai-edit-review-line--header";
  if (line.startsWith("+")) return "ai-edit-review-line--added";
  if (line.startsWith("-")) return "ai-edit-review-line--removed";
  return "ai-edit-review-line--context";
}

export function AssistantEditReviewPane({
  proposal,
  canAccept,
  onReject,
  onAccept,
  t
}: {
  proposal: AssistantEditProposal;
  canAccept: boolean;
  onReject: () => void;
  onAccept: () => void;
  t: Translator;
}) {
  const warnings = proposal.verification.diagnostics.filter(
    ({ severity }) => severity !== "error"
  );
  return (
    <section className="ai-edit-review" aria-label={t("ai.review.title")}>
      <header className="ai-edit-review-heading">
        <div>
          <h3>{t("ai.review.title")}</h3>
          <p>{proposal.path}</p>
        </div>
        <div className="ai-edit-review-stats">
          {proposal.editKind === "full-file" && (
            <UiBadge tone="warning">{t("ai.review.fullFile")}</UiBadge>
          )}
          <UiBadge tone="success">+{proposal.addedLines}</UiBadge>
          <UiBadge tone="warning">−{proposal.removedLines}</UiBadge>
          <UiBadge tone="neutral">{t("ai.review.hunks", { count: proposal.hunkCount })}</UiBadge>
        </div>
      </header>
      <p className="ai-edit-review-notice">{t("ai.review.notice")}</p>
      {proposal.editKind === "full-file" && (
        <p className="ai-edit-review-notice">{t("ai.review.fullFileNotice")}</p>
      )}
      <div className="ai-edit-review-verification" data-testid="ai-review-compile-passed">
        <UiBadge tone="success">{t("ai.review.compilePassed")}</UiBadge>
        {warnings.length > 0 && (
          <span>{t("ai.review.compileWarnings", { count: warnings.length })}</span>
        )}
      </div>
      {warnings.length > 0 && (
        <ul className="ai-edit-review-diagnostics" aria-label={t("ai.review.compileDiagnostics")}>
          {warnings.slice(0, 5).map((diagnostic, index) => {
            const location = diagnostic.path
              ? `${diagnostic.path}${diagnostic.line ? `:${diagnostic.line}` : ""}${
                  diagnostic.column ? `:${diagnostic.column}` : ""
                }`
              : "";
            return (
              <li key={`${index}:${location}:${diagnostic.message}`}>
                {location && <code>{location}</code>}
                <span>{diagnostic.message}</span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="ai-edit-review-code" role="region" aria-label={t("ai.review.diffLabel")}>
        {proposal.patch.split("\n").map((line, index) => (
          <code
            className={diffLineClass(line)}
            key={`${index}:${line}`}
          >
            {line || " "}
          </code>
        ))}
      </div>
      <footer className="ai-edit-review-footer">
        <small title={proposal.baseSnapshot}>
          {t("ai.review.snapshot", { snapshot: proposal.baseSnapshot.slice(0, 19) })}
        </small>
        <div>
          <UiButton type="button" variant="ghost" onClick={onReject} data-testid="ai-review-reject">
            {t("ai.review.reject")}
          </UiButton>
          <UiButton
            type="button"
            variant="primary"
            disabled={!canAccept}
            onClick={onAccept}
            data-testid="ai-review-accept"
          >
            {t("ai.review.accept")}
          </UiButton>
        </div>
      </footer>
    </section>
  );
}
