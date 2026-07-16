import { Eye, GitBranch, UsersRound } from "lucide-react";
import "@/pages/home.css";
import "@/pages/public-pages.css";
import { ExperienceResourceLink } from "@/components/ExperienceResourceLink";
import { UiButton } from "@/components/ui";
import type { Experience } from "@/lib/api";
import { localizedText } from "@/lib/experience";
import type { Translator, UiLocale } from "@/lib/i18n";

const highlightIcons = [UsersRound, Eye, GitBranch];

export function HomePage({
  experience,
  locale,
  t,
  onSignIn,
  onOpenHelp
}: {
  experience: Experience;
  locale: UiLocale;
  t: Translator;
  onSignIn: () => void;
  onOpenHelp: () => void;
}) {
  return (
    <section className="home-page">
      <div className="home-hero">
        <div className="home-hero-copy">
          <span className="home-eyebrow">{t("home.eyebrow")}</span>
          <h1>{localizedText(experience.landing.headline, locale)}</h1>
          <p>{localizedText(experience.landing.summary, locale)}</p>
          <div className="home-hero-actions">
            <UiButton variant="primary" size="lg" onClick={onSignIn}>
              {t("home.signIn")}
            </UiButton>
            <UiButton variant="secondary" size="lg" onClick={onOpenHelp}>
              {t("home.openHelp")}
            </UiButton>
          </div>
        </div>
        <div className="home-product-visual" aria-hidden>
          <div className="home-visual-window">
            <div className="home-visual-toolbar">
              <span />
              <span />
              <span />
            </div>
            <div className="home-visual-workspace">
              <div className="home-visual-code">
                <i className="wide" />
                <i />
                <i className="medium" />
                <i className="accent" />
                <i className="short" />
                <i className="medium" />
              </div>
              <div className="home-visual-preview">
                <div className="home-visual-slide">
                  <b />
                  <i />
                  <i />
                  <span />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="home-highlights">
        {experience.landing.highlights.map((highlight, index) => {
          const Icon = highlightIcons[index] ?? Eye;
          return (
            <article className="home-highlight" key={`${highlight.title.en}-${index}`}>
              <span className="home-highlight-icon" aria-hidden>
                <Icon size={20} />
              </span>
              <h2>{localizedText(highlight.title, locale)}</h2>
              <p>{localizedText(highlight.description, locale)}</p>
            </article>
          );
        })}
      </div>

      <section className="home-resources" aria-labelledby="home-resources-title">
        <div className="home-section-heading">
          <h2 id="home-resources-title">{t("home.resources")}</h2>
        </div>
        <div className="experience-resource-grid">
          {experience.resources.map((resource) => (
            <ExperienceResourceLink
              key={resource.id}
              resource={resource}
              locale={locale}
              t={t}
            />
          ))}
        </div>
      </section>
    </section>
  );
}
