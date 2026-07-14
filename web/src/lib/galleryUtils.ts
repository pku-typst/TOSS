import type { TemplateGalleryItem, TemplateSource } from "@/lib/api";
import type { UiLocale } from "@/lib/i18n";

export type GallerySourceFilter = "all" | TemplateSource;

export function localizedTemplateText(
  value: TemplateGalleryItem["name"] | TemplateGalleryItem["description"],
  locale: UiLocale
) {
  return value[locale] || value.en;
}

export function filterGalleryTemplates(
  templates: TemplateGalleryItem[],
  options: {
    locale: UiLocale;
    query: string;
    source: GallerySourceFilter;
    category: string;
  }
) {
  const query = options.query.trim().toLocaleLowerCase(options.locale);
  const sourceRank: Record<TemplateSource, number> = {
    builtin: 0,
    personal: 1,
    shared: 2
  };

  return templates
    .filter((template) => options.source === "all" || template.source === options.source)
    .filter((template) => options.category === "all" || template.category === options.category)
    .filter((template) => {
      if (!query) return true;
      const haystack = [
        template.name.en,
        template.name["zh-CN"],
        template.description.en,
        template.description["zh-CN"],
        template.category,
        template.owner_display_name ?? "",
        ...template.tags
      ]
        .join("\n")
        .toLocaleLowerCase(options.locale);
      return haystack.includes(query);
    })
    .sort((left, right) => {
      if (left.featured !== right.featured) return left.featured ? -1 : 1;
      const sourceDifference = sourceRank[left.source] - sourceRank[right.source];
      if (sourceDifference !== 0) return sourceDifference;
      return localizedTemplateText(left.name, options.locale).localeCompare(
        localizedTemplateText(right.name, options.locale),
        options.locale
      );
    });
}
