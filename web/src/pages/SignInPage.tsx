import { AuthForm } from "@/components/AuthForm";
import { BrandMark } from "@/components/BrandMark";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { UiCard } from "@/components/ui";
import type { AuthConfig, ExternalGitProvider } from "@/lib/api";
import type { Translator, UiLocale } from "@/lib/i18n";

export function SignInPage({
  config,
  locale,
  t,
  onLocaleChange,
  showLocaleSwitcher = true,
  returnTo = "/projects",
  accountLinkProvider = null,
  onSignedIn
}: {
  config: AuthConfig | null;
  locale: UiLocale;
  t: Translator;
  onLocaleChange: (locale: UiLocale) => void;
  showLocaleSwitcher?: boolean;
  returnTo?: string;
  accountLinkProvider?: ExternalGitProvider | null;
  onSignedIn: () => Promise<void>;
}) {
  const localAccountEnabled = !!(
    config?.allow_local_login ||
    (config?.allow_local_registration && !accountLinkProvider)
  );
  const hasIdentityProviders = (config?.identity_providers.length ?? 0) > 0;
  const authLayout = localAccountEnabled
    ? hasIdentityProviders
      ? "mixed"
      : "local"
    : hasIdentityProviders
      ? "providers"
      : "unavailable";
  const subtitleKey = `auth.subtitle.${authLayout}`;

  return (
    <section className="auth-shell" data-auth-layout={authLayout}>
      {showLocaleSwitcher && (
        <LocaleSwitcher
          className="auth-locale-switcher"
          locale={locale}
          onChange={onLocaleChange}
          t={t}
        />
      )}
      <div className="auth-layout">
        <div className="auth-showcase" aria-hidden="true">
          <div className="auth-showcase-window">
            <div className="auth-showcase-toolbar">
              <span />
              <span />
              <span />
            </div>
            <div className="auth-showcase-workspace">
              <div className="auth-showcase-source">
                <i className="wide" />
                <i />
                <i className="medium" />
                <i className="accent" />
                <i className="short" />
                <i className="medium" />
              </div>
              <div className="auth-showcase-preview">
                <div className="auth-showcase-page">
                  <i className="title" />
                  <i />
                  <i />
                  <i className="short" />
                </div>
              </div>
            </div>
          </div>
          <span className="auth-showcase-cursor cursor-one" />
          <span className="auth-showcase-cursor cursor-two" />
        </div>
        <UiCard
          className="auth-card"
          contentLayout="column gap:lg pad:xl align:horizontal-stretch"
        >
          <div className="auth-brand">
            <BrandMark
              className="auth-brand-mark"
              mark={config?.brand_mark?.trim() || "T"}
              label={config?.site_name?.trim() || t("brand.name")}
            />
            <strong>{config?.site_name?.trim() || t("brand.name")}</strong>
          </div>
          <div className="auth-heading">
            <h1>{t("auth.signIn")}</h1>
            <p>{t(subtitleKey)}</p>
          </div>
          {accountLinkProvider ? (
            <div className="auth-account-link-notice" role="status">
              {t("auth.accountLinkRequired", {
                provider: accountLinkProvider.display_name
              })}
            </div>
          ) : null}
          <AuthForm
            config={config}
            t={t}
            onSignedIn={onSignedIn}
            returnTo={returnTo}
            disabledIdentityProviderId={
              accountLinkProvider
                ? `external-git:${accountLinkProvider.id}`
                : undefined
            }
            existingAccountOnly={!!accountLinkProvider}
          />
        </UiCard>
      </div>
    </section>
  );
}
