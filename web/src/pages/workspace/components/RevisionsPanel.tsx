import { HistoryPanel } from "@/components/HistoryPanel";
import { UiButton, UiDialog, UiIconButton, UiInput } from "@/components/ui";
import { Camera, History, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { Revision } from "@/lib/api";
import type { Translator, UiLocale } from "@/lib/i18n";

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function RevisionsPanel({
  width,
  revisions,
  activeRevisionId,
  loading,
  loadingRevisionId,
  loadingBytes,
  loadingTotalBytes,
  hasMore,
  loadingMore,
  canWrite,
  isRevisionMode,
  onCreateRevision,
  onOpenRevision,
  onLoadMore,
  locale,
  t
}: {
  width: number;
  revisions: Revision[];
  activeRevisionId: string | null;
  loading: boolean;
  loadingRevisionId: string | null;
  loadingBytes: number;
  loadingTotalBytes: number | null;
  hasMore: boolean;
  loadingMore: boolean;
  canWrite: boolean;
  isRevisionMode: boolean;
  onCreateRevision: (summary: string) => Promise<void>;
  onOpenRevision: (revisionId: string) => void;
  onLoadMore: () => void;
  locale: UiLocale;
  t: Translator;
}) {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [creationPending, setCreationPending] = useState(false);
  const [creationError, setCreationError] = useState<string | null>(null);
  const percent =
    loadingTotalBytes && loadingTotalBytes > 0
      ? Math.max(0, Math.min(100, Math.round((100 * loadingBytes) / loadingTotalBytes)))
      : null;
  const loadingIdText = loadingRevisionId ? `${t("revisions.loadingId")} ${loadingRevisionId.slice(0, 8)}…` : "";
  const loadingBytesText = loadingTotalBytes
    ? `${formatBytes(loadingBytes)} / ${formatBytes(loadingTotalBytes)}`
    : loadingBytes > 0
      ? formatBytes(loadingBytes)
      : "";
  const loadingMeta = [loadingIdText, loadingBytesText].filter(Boolean).join(" · ");

  function openCreateDialog() {
    if (!canWrite || isRevisionMode || creationPending) return;
    setCreationError(null);
    setSummary("");
    setCreateDialogOpen(true);
  }

  function closeCreateDialog() {
    if (creationPending) return;
    setCreationError(null);
    setCreateDialogOpen(false);
    setSummary("");
  }

  async function submitRevision() {
    const normalizedSummary = summary.trim();
    if (!normalizedSummary || creationPending) return;
    setCreationPending(true);
    setCreationError(null);
    try {
      await onCreateRevision(normalizedSummary);
      setCreateDialogOpen(false);
      setSummary("");
    } catch (error) {
      setCreationError(
        error instanceof Error ? error.message : t("revisions.createFailed")
      );
    } finally {
      setCreationPending(false);
    }
  }

  return (
    <>
      <aside className="panel panel-revisions" style={{ width }}>
        <div className="panel-header">
          <h2 className="panel-header-title-with-icon">
            <History size={13} aria-hidden />
            {t("workspace.revisions")}
          </h2>
          <div className="revision-panel-header-actions">
            <span className="panel-header-count">{revisions.length}</span>
            {canWrite && (
              <UiIconButton
                tooltip={
                  isRevisionMode
                    ? t("revisions.createLiveOnly")
                    : t("revisions.create")
                }
                label={t("revisions.create")}
                onClick={openCreateDialog}
                disabled={isRevisionMode || creationPending}
              >
                {creationPending ? (
                  <LoaderCircle className="history-spin" size={14} aria-hidden />
                ) : (
                  <Camera size={14} aria-hidden />
                )}
              </UiIconButton>
            )}
          </div>
        </div>
        <div className="panel-content">
          <HistoryPanel
            revisions={revisions.map((revision) => ({
              id: revision.id,
              summary:
                revision.summary === "Online updates"
                  ? t("revisions.onlineUpdates")
                  : revision.summary,
              createdAt: revision.created_at,
              kind:
                revision.summary === "Online updates" ? "online" : "snapshot",
              author:
                revision.authors.length > 0
                  ? revision.authors
                      .map((author) =>
                        author.display_name === "Typst Server"
                          ? t("revisions.serverAuthor")
                          : author.display_name
                      )
                      .join(", ")
                  : revision.actor_user_id || t("revisions.unknownAuthor")
            }))}
            locale={locale}
            selectedId={activeRevisionId}
            loadingRevisionId={loading ? loadingRevisionId : null}
            loadingPercent={loading ? percent : null}
            loadingLabel={t("revisions.loadingSnapshot")}
            loadingMeta={loading ? loadingMeta : ""}
            emptyLabel={t("revisions.empty")}
            hasMore={hasMore}
            loadingMore={loadingMore}
            loadingMoreLabel={t("revisions.loadingMore")}
            onLoadMore={onLoadMore}
            onSelect={(revisionId) => {
              if (loading && loadingRevisionId === revisionId) return;
              onOpenRevision(revisionId);
            }}
          />
        </div>
      </aside>
      <UiDialog
        open={createDialogOpen}
        title={t("revisions.createTitle")}
        description={t("revisions.createDescription")}
        onClose={closeCreateDialog}
        actions={
          <>
            <UiButton onClick={closeCreateDialog} disabled={creationPending}>
              {t("common.cancel")}
            </UiButton>
            <UiButton
              variant="primary"
              onClick={() => void submitRevision()}
              disabled={creationPending || !summary.trim()}
            >
              {creationPending ? (
                <>
                  <LoaderCircle className="history-spin" size={14} aria-hidden />
                  {t("revisions.creating")}
                </>
              ) : (
                t("revisions.createAction")
              )}
            </UiButton>
          </>
        }
      >
        <UiInput
          autoFocus
          label={t("revisions.summaryLabel")}
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.nativeEvent.isComposing ||
              creationPending
            ) {
              return;
            }
            event.preventDefault();
            void submitRevision();
          }}
          placeholder={t("revisions.summaryPlaceholder")}
          error={creationError}
          disabled={creationPending}
        />
      </UiDialog>
    </>
  );
}
