import { Activity, BookOpen, Boxes, ExternalLink, GitBranch, LifeBuoy } from "lucide-react";
import type { ExperienceResource, ExperienceResourceKind } from "@/lib/api";
import { localizedText } from "@/lib/experience";
import type { Translator, UiLocale } from "@/lib/i18n";

function ResourceIcon({ kind }: { kind: ExperienceResourceKind }) {
  if (kind === "packages") return <Boxes size={18} aria-hidden />;
  if (kind === "repository") return <GitBranch size={18} aria-hidden />;
  if (kind === "support") return <LifeBuoy size={18} aria-hidden />;
  if (kind === "status") return <Activity size={18} aria-hidden />;
  return <BookOpen size={18} aria-hidden />;
}

export function ExperienceResourceLink({
  resource,
  locale,
  t,
  compact = false
}: {
  resource: ExperienceResource;
  locale: UiLocale;
  t: Translator;
  compact?: boolean;
}) {
  const label = localizedText(resource.label, locale);
  return (
    <a
      className={`experience-resource-link ${compact ? "compact" : ""}`.trim()}
      href={resource.url}
      target="_blank"
      rel="noreferrer"
      aria-label={`${label}. ${t("home.externalLink")}`}
    >
      <span className="experience-resource-icon">
        <ResourceIcon kind={resource.kind} />
      </span>
      <span className="experience-resource-copy">
        <strong>{label}</strong>
        {!compact && <small>{localizedText(resource.description, locale)}</small>}
      </span>
      <ExternalLink className="experience-resource-external" size={14} aria-hidden />
    </a>
  );
}
