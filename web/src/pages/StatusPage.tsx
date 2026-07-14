import { Ban, CircleAlert, FileQuestion, FolderX } from "lucide-react";
import { UiButton } from "@/components/ui";

type StatusKind = "not-found" | "forbidden" | "project" | "startup";

function StatusIcon({ kind }: { kind: StatusKind }) {
  if (kind === "forbidden") return <Ban size={30} aria-hidden />;
  if (kind === "project") return <FolderX size={30} aria-hidden />;
  if (kind === "startup") return <CircleAlert size={30} aria-hidden />;
  return <FileQuestion size={30} aria-hidden />;
}

export function StatusPage({
  kind,
  title,
  description,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondaryAction
}: {
  kind: StatusKind;
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
  secondaryLabel?: string;
  onSecondaryAction?: () => void;
}) {
  return (
    <section className={`status-page status-${kind}`}>
      <span className="status-page-icon">
        <StatusIcon kind={kind} />
      </span>
      <div className="status-page-copy">
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="status-page-actions">
        <UiButton variant="primary" onClick={onAction}>
          {actionLabel}
        </UiButton>
        {secondaryLabel && onSecondaryAction && (
          <UiButton onClick={onSecondaryAction}>{secondaryLabel}</UiButton>
        )}
      </div>
    </section>
  );
}
