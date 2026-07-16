import type { UiLocale } from "@/lib/i18n";

type LocalizedText = { en: string; "zh-CN": string };
type ManagedModelProfile = {
  id: string;
  model: string;
  label: LocalizedText;
};

const MANAGED_MODEL_SEARCH_THRESHOLD = 8;

export function localizedAiText(value: LocalizedText, locale: UiLocale) {
  return value[locale];
}

export function filterManagedModelProfiles<T extends ManagedModelProfile>(
  profiles: readonly T[],
  query: string,
  locale: UiLocale
) {
  const normalizedQuery = query.trim().toLocaleLowerCase(locale);
  if (!normalizedQuery) return profiles;
  return profiles.filter((profile) => (
    profile.model.toLocaleLowerCase(locale).includes(normalizedQuery) ||
    localizedAiText(profile.label, locale).toLocaleLowerCase(locale).includes(normalizedQuery)
  ));
}

export function shouldShowManagedModelSearch(profileCount: number) {
  return profileCount > MANAGED_MODEL_SEARCH_THRESHOLD;
}
