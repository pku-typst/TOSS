import { useMemo, useState } from "react";
import "@/pages/help.css";
import "@/pages/public-pages.css";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, CircleAlert, Search } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useSearchParams } from "react-router-dom";
import { ExperienceResourceLink } from "@/components/ExperienceResourceLink";
import { UiButton, UiEmptyState, UiInput, UiPageHeading, UiSelect } from "@/components/ui";
import { getHelpContent } from "@/lib/api";
import { localizedText } from "@/lib/experience";
import type { Translator, UiLocale } from "@/lib/i18n";

export function HelpPage({
  cacheIdentity,
  locale,
  t
}: {
  cacheIdentity: string;
  locale: UiLocale;
  t: Translator;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const selectedId = searchParams.get("topic") ?? "";
  const helpQuery = useQuery({
    queryKey: ["help-content", cacheIdentity],
    queryFn: getHelpContent,
    staleTime: 30 * 60 * 1000
  });
  const content = helpQuery.data ?? null;

  const filteredTopics = useMemo(() => {
    if (!content) return [];
    const needle = query.trim().toLocaleLowerCase(locale);
    if (!needle) return content.topics;
    return content.topics.filter((topic) =>
      [
        localizedText(topic.title, locale),
        localizedText(topic.summary, locale),
        localizedText(topic.content, locale)
      ]
        .join("\n")
        .toLocaleLowerCase(locale)
        .includes(needle)
    );
  }, [content, locale, query]);

  const activeTopic =
    filteredTopics.find((topic) => topic.id === selectedId) ?? filteredTopics[0] ?? null;

  function selectTopic(id: string) {
    setSearchParams({ topic: id }, { replace: true });
  }

  return (
    <section className="help-page app-page">
      <UiPageHeading
        icon={<BookOpen size={24} />}
        title={t("help.title")}
        description={t("help.subtitle")}
      />

      {helpQuery.isPending && <div className="help-state" role="status">{t("help.loading")}</div>}
      {helpQuery.isError && !content && (
        <UiEmptyState
          className="help-state"
          role="alert"
          icon={<CircleAlert size={24} />}
          iconFrame
          title={t("help.loadFailed")}
          description={helpQuery.error instanceof Error ? helpQuery.error.message : undefined}
          actions={<UiButton onClick={() => void helpQuery.refetch()}>{t("common.retry")}</UiButton>}
        />
      )}

      {content && (
        <>
          <div className="help-search-row">
            <Search size={16} aria-hidden />
            <UiInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("help.search")}
              aria-label={t("help.search")}
            />
          </div>

          <UiSelect
            className="help-topic-picker"
            label={t("help.topics")}
            value={activeTopic?.id ?? ""}
            disabled={filteredTopics.length === 0}
            onChange={(event) => selectTopic(event.target.value)}
          >
            {filteredTopics.length === 0 ? (
              <option value="">{t("help.noResults")}</option>
            ) : (
              filteredTopics.map((topic) => (
                <option key={topic.id} value={topic.id}>
                  {localizedText(topic.title, locale)}
                </option>
              ))
            )}
          </UiSelect>

          <div className="help-layout">
            <aside className="help-topic-nav" aria-label={t("help.topics")}>
              <h2>{t("help.topics")}</h2>
              {filteredTopics.map((topic) => (
                <button
                  type="button"
                  key={topic.id}
                  className={activeTopic?.id === topic.id ? "active" : ""}
                  aria-current={activeTopic?.id === topic.id ? "page" : undefined}
                  onClick={() => selectTopic(topic.id)}
                >
                  <strong>{localizedText(topic.title, locale)}</strong>
                  <small>{localizedText(topic.summary, locale)}</small>
                </button>
              ))}
              {filteredTopics.length === 0 && <p className="help-no-results">{t("help.noResults")}</p>}
            </aside>

            <article className="help-article">
              {activeTopic ? (
                <>
                  <header>
                    <h2>{localizedText(activeTopic.title, locale)}</h2>
                    <p>{localizedText(activeTopic.summary, locale)}</p>
                  </header>
                  <div className="help-markdown">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ href, children, ...props }) => {
                          const external = href?.startsWith("https://") || href?.startsWith("http://");
                          return (
                            <a
                              {...props}
                              href={href}
                              target={external ? "_blank" : undefined}
                              rel={external ? "noreferrer" : undefined}
                            >
                              {children}
                            </a>
                          );
                        }
                      }}
                    >
                      {localizedText(activeTopic.content, locale)}
                    </ReactMarkdown>
                  </div>
                </>
              ) : (
                <div className="help-no-results">{t("help.noResults")}</div>
              )}
            </article>
          </div>

          <section className="help-resources" aria-labelledby="help-resources-title">
            <h2 id="help-resources-title">{t("help.resources")}</h2>
            <div className="experience-resource-grid">
              {content.resources.map((resource) => (
                <ExperienceResourceLink
                  key={resource.id}
                  resource={resource}
                  locale={locale}
                  t={t}
                />
              ))}
            </div>
          </section>
        </>
      )}
    </section>
  );
}
