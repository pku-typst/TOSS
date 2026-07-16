import { useEffect, useRef, type UIEvent } from "react";
import {
  Clock3,
  Cloud,
  GitCommitHorizontal,
  History,
  LoaderCircle,
  UserRound
} from "lucide-react";
import { UiTooltip } from "@/components/ui";
import { formatDateTime, type UiLocale } from "@/lib/i18n";

type Revision = {
  id: string;
  author: string;
  summary: string;
  createdAt: string;
  kind?: "online" | "snapshot";
};

export function formatRevisionRelativeTime(iso: string, locale: UiLocale, now = Date.now()) {
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return iso;

  const seconds = Math.round((timestamp - now) / 1000);
  const absoluteSeconds = Math.abs(seconds);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 24 * 60 * 60],
    ["month", 30 * 24 * 60 * 60],
    ["week", 7 * 24 * 60 * 60],
    ["day", 24 * 60 * 60],
    ["hour", 60 * 60],
    ["minute", 60]
  ];
  const [unit, divisor] = units.find(([, candidate]) => absoluteSeconds >= candidate) ?? ["minute", 60];
  const value = absoluteSeconds < 60 ? 0 : Math.round(seconds / divisor);
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(value, unit);
}

export function HistoryPanel({
  revisions,
  selectedId,
  loadingRevisionId,
  loadingPercent,
  loadingLabel,
  loadingMeta,
  emptyLabel,
  hasMore,
  loadingMore,
  loadingMoreLabel,
  locale,
  onLoadMore,
  onSelect
}: {
  revisions: Revision[];
  selectedId?: string | null;
  loadingRevisionId?: string | null;
  loadingPercent?: number | null;
  loadingLabel: string;
  loadingMeta?: string;
  emptyLabel: string;
  hasMore?: boolean;
  loadingMore?: boolean;
  loadingMoreLabel: string;
  locale: UiLocale;
  onLoadMore?: () => void;
  onSelect?: (revisionId: string) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hasMore || loadingMore || !onLoadMore) return;
    const element = listRef.current;
    if (!element) return;
    if (element.scrollHeight <= element.clientHeight + 8) {
      onLoadMore();
    }
  }, [hasMore, loadingMore, onLoadMore, revisions.length]);

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    if (!hasMore || loadingMore || !onLoadMore) return;
    const element = event.currentTarget;
    if (element.scrollTop + element.clientHeight >= element.scrollHeight - 96) {
      onLoadMore();
    }
  }

  return (
    <div className="history-list" onScroll={handleScroll} ref={listRef} role="list">
      {revisions.map((revision) => {
        const isLoading = loadingRevisionId === revision.id;
        const isSelected = selectedId === revision.id;
        const exactTime = formatDateTime(locale, revision.createdAt);
        return (
          <div
            key={revision.id}
            className={`history-timeline-entry ${isSelected ? "active" : ""} ${isLoading ? "loading" : ""}`}
            role="listitem"
          >
            <span className="history-timeline-marker" aria-hidden>
              {isLoading ? (
                <LoaderCircle className="history-spin" size={14} />
              ) : revision.kind === "online" ? (
                <Cloud size={14} />
              ) : (
                <GitCommitHorizontal size={14} />
              )}
            </span>
            <nve-button
              className={`history-item ${isSelected ? "active" : ""} ${isLoading ? "loading" : ""}`}
              role="button"
              container="flat"
              selected={isSelected}
              pressed={isSelected}
              onClick={() => onSelect?.(revision.id)}
              aria-label={`${revision.summary}, ${revision.author}, ${exactTime}`}
              aria-busy={isLoading ? "true" : "false"}
            >
              <div className="history-item-content">
                <div className="history-item-heading">
                  <strong>{revision.summary}</strong>
                  <UiTooltip content={exactTime} className="history-time-tooltip">
                    <span className="history-relative-time">
                      <Clock3 size={11} aria-hidden />
                      <span>{formatRevisionRelativeTime(revision.createdAt, locale)}</span>
                    </span>
                  </UiTooltip>
                </div>
                <span className="history-author">
                  <UserRound size={11} aria-hidden />
                  <span>{revision.author}</span>
                </span>
                {isLoading && (
                  <div className="history-item-loading">
                    <div className="history-item-loading-label">
                      <span>{loadingLabel}</span>
                      <span>{loadingPercent !== null && loadingPercent !== undefined ? `${loadingPercent}%` : ""}</span>
                    </div>
                    <nve-progress-bar
                      status="accent"
                      value={loadingPercent !== null && loadingPercent !== undefined ? loadingPercent : undefined}
                    />
                    {loadingMeta ? <small>{loadingMeta}</small> : null}
                  </div>
                )}
              </div>
            </nve-button>
          </div>
        );
      })}
      {revisions.length === 0 && !loadingMore ? (
        <div className="history-empty">
          <span className="history-empty-icon" aria-hidden>
            <History size={20} />
          </span>
          <span>{emptyLabel}</span>
        </div>
      ) : null}
      {loadingMore ? (
        <div className="history-list-more">
          <span>
            <LoaderCircle className="history-spin" size={13} aria-hidden />
            {loadingMoreLabel}
          </span>
          <nve-progress-bar status="accent" />
        </div>
      ) : null}
    </div>
  );
}
