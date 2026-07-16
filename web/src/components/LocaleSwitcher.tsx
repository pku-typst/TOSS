import { UiSelect } from "@/components/ui";
import type { Translator, UiLocale } from "@/lib/i18n";

export function LocaleSwitcher({
  locale,
  onChange,
  t,
  className = ""
}: {
  locale: UiLocale;
  onChange: (locale: UiLocale) => void;
  t: Translator;
  className?: string;
}) {
  return (
    <UiSelect
      className={`locale-switcher ${className}`.trim()}
      value={locale}
      onChange={(event) => onChange(event.target.value === "zh-CN" ? "zh-CN" : "en")}
      aria-label={t("language.label")}
      title={t("language.label")}
    >
      <option value="en">{t("language.english")}</option>
      <option value="zh-CN">{t("language.chineseSimplified")}</option>
    </UiSelect>
  );
}
