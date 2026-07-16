import { useState, type FormEvent } from "react";
import "@/components/auth-form.css";
import { ArrowRight, KeyRound } from "lucide-react";
import { ProviderBrandMark } from "@/components/ProviderBrandMark";
import { UiButton, UiInput } from "@/components/ui";
import {
  identityLoginUrl,
  localLogin,
  localRegister,
  type AuthConfig
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";

type AuthFormProps = {
  config: AuthConfig | null;
  t: Translator;
  onSignedIn: () => Promise<void>;
  compact?: boolean;
  returnTo?: string;
  disabledIdentityProviderId?: string;
  existingAccountOnly?: boolean;
};

const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])$/;

type AuthMode = "login" | "register";

function availableMode(
  requested: AuthMode,
  localLoginEnabled: boolean,
  localRegistrationEnabled: boolean
): AuthMode {
  if (requested === "login" && localLoginEnabled) return "login";
  if (requested === "register" && localRegistrationEnabled) return "register";
  return localLoginEnabled ? "login" : "register";
}

export function AuthForm({
  config,
  t,
  onSignedIn,
  compact = false,
  returnTo = "/projects",
  disabledIdentityProviderId,
  existingAccountOnly = false
}: AuthFormProps) {
  const [requestedMode, setRequestedMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const localLoginEnabled = !!config?.allow_local_login;
  const localRegistrationEnabled =
    !!config?.allow_local_registration && !existingAccountOnly;
  const identityProviders = config?.identity_providers ?? [];
  const localAccountEnabled = localLoginEnabled || localRegistrationEnabled;
  const hasIdentityProviders = identityProviders.length > 0;
  const mode = availableMode(requestedMode, localLoginEnabled, localRegistrationEnabled);
  const layout = localAccountEnabled
    ? hasIdentityProviders
      ? "mixed"
      : "local"
    : hasIdentityProviders
      ? "providers"
      : "unavailable";

  async function submit() {
    const normalizedUsername = username.trim().toLowerCase();
    if (mode === "register" && !USERNAME_PATTERN.test(normalizedUsername)) {
      setError(t("api.error.authUsernameInvalid"));
      return;
    }
    try {
      setSubmitting(true);
      setError(null);
      if (mode === "login") {
        await localLogin(email.trim(), password);
      } else {
        await localRegister({
          email: email.trim(),
          username: normalizedUsername,
          password,
          display_name: displayName.trim() || undefined
        });
      }
      await onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.failed"));
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      submitting ||
      !localAccountEnabled ||
      !email.trim() ||
      !password ||
      (mode === "register" && !username.trim())
    ) {
      return;
    }
    void submit();
  }

  return (
    <form
      className={`auth-form ${compact ? "compact" : ""}`}
      data-auth-layout={layout}
      aria-busy={submitting}
      onSubmit={handleSubmit}
    >
      {config?.announcement?.trim() && (
        <div className="auth-announcement-banner" role="status">
          {config.announcement.trim()}
        </div>
      )}
      {hasIdentityProviders && (
        <section
          className="auth-provider-section"
          role="group"
          aria-label={t("auth.providersLabel")}
        >
          <div className="auth-section-label">{t("auth.providersLabel")}</div>
          <div
            className="auth-provider-list"
            data-provider-count={identityProviders.length}
          >
            {identityProviders.map((provider) => {
              const label = t("auth.providerLogin", { provider: provider.display_name });
              return (
                <UiButton
                  key={provider.id}
                  type="button"
                  variant="secondary"
                  size="lg"
                  className="auth-provider-button"
                  data-provider-brand={provider.brand}
                  aria-label={label}
                  disabled={provider.id === disabledIdentityProviderId}
                  onClick={() => window.location.assign(identityLoginUrl(provider, returnTo))}
                >
                  <ProviderBrandMark
                    brand={provider.brand}
                    size={31}
                    className="auth-provider-icon"
                  />
                  <span className="auth-provider-name">{provider.display_name}</span>
                  <ArrowRight className="auth-provider-arrow" size={17} aria-hidden />
                </UiButton>
              );
            })}
          </div>
        </section>
      )}
      {hasIdentityProviders && localAccountEnabled && (
        <div className="auth-divider" role="separator">
          <span>{t("auth.orUseEmail")}</span>
        </div>
      )}
      {localAccountEnabled && (
        <section className="auth-local-section" aria-label={t("auth.emailAccount")}>
          {localLoginEnabled && localRegistrationEnabled && (
            <div className="auth-mode-switcher" role="group" aria-label={t("auth.emailAccount")}>
              <UiButton
                type="button"
                variant="ghost"
                className={mode === "login" ? "active" : ""}
                aria-pressed={mode === "login"}
                onClick={() => setRequestedMode("login")}
              >
                {t("auth.loginTab")}
              </UiButton>
              <UiButton
                type="button"
                variant="ghost"
                className={mode === "register" ? "active" : ""}
                aria-pressed={mode === "register"}
                onClick={() => setRequestedMode("register")}
              >
                {t("auth.registerTab")}
              </UiButton>
            </div>
          )}
          <div className="auth-fields">
            <UiInput
              label={t("auth.email")}
              name="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={t("auth.email")}
            />
            {mode === "register" && (
              <UiInput
                label={t("auth.username")}
                name="username"
                required
                minLength={2}
                maxLength={64}
                pattern="[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder={t("auth.username")}
              />
            )}
            <UiInput
              label={t("auth.password")}
              name="password"
              value={password}
              type="password"
              required
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("auth.password")}
            />
            {mode === "register" && (
              <UiInput
                label={t("auth.displayNameOptional")}
                name="display-name"
                autoComplete="name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={t("auth.displayNameOptional")}
              />
            )}
            <UiButton
              type="button"
              className="auth-submit"
              variant="primary"
              size="lg"
              onClick={submit}
              disabled={
                submitting ||
                !email.trim() ||
                !password ||
                (mode === "register" && !username.trim())
              }
            >
              {submitting
                ? t("common.loading")
                : mode === "login"
                  ? t("auth.loginAction")
                  : t("auth.registerAction")}
            </UiButton>
            <button
              className="auth-native-submit"
              type="submit"
              tabIndex={-1}
              aria-hidden="true"
            />
          </div>
        </section>
      )}
      {layout === "unavailable" && (
        <div className="auth-unavailable" role="status">
          <KeyRound size={18} aria-hidden />
          <span>{t("auth.noMethods")}</span>
        </div>
      )}
      {error && (
        <nve-alert status="danger" className="auth-error" role="alert">
          {error}
        </nve-alert>
      )}
    </form>
  );
}
