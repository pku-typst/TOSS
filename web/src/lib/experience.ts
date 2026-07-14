import type { LocalizedText } from "@/lib/api";
import type { UiLocale } from "@/lib/i18n";

export function localizedText(value: LocalizedText, locale: UiLocale) {
  return value[locale] || value.en;
}

export function safeReturnPath(raw: string | null | undefined, fallback = "/projects") {
  const value = raw?.trim() ?? "";
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.length > 2048 ||
    [...value].some((character) => character.charCodeAt(0) < 0x20)
  ) {
    return fallback;
  }
  try {
    const parsed = new URL(value, "https://app.invalid");
    if (parsed.origin !== "https://app.invalid" || parsed.pathname === "/signin") return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
