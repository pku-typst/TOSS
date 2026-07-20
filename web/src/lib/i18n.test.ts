import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UI_LOCALE_STORAGE_KEY,
  apiStatusMessage,
  interpolateTranslation,
  localizeApiErrorDetail,
  localizeClientError,
  readStoredLocale,
  translate,
  translationKeys,
  writeStoredLocale
} from "@/lib/i18n";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("translation catalogs", () => {
  it("keeps English and Simplified Chinese keys aligned", () => {
    expect(translationKeys("zh-CN")).toEqual(translationKeys("en"));
  });

  it("interpolates supplied values and preserves missing placeholders", () => {
    expect(
      interpolateTranslation("{first}/{second}/{missing}", {
        first: "a",
        second: 2
      })
    ).toBe("a/2/{missing}");
  });

  it("returns an unknown translation key as the fallback", () => {
    expect(translate("zh-CN", "missing.key")).toBe("missing.key");
  });
});

describe("locale persistence", () => {
  it("prefers a stored locale over browser language", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: () => "en" },
      navigator: { language: "zh-CN", languages: ["zh-CN"] }
    });
    expect(readStoredLocale()).toBe("en");
  });

  it("detects Chinese browser locales when no preference is stored", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: () => null },
      navigator: { language: "zh-TW", languages: ["zh-TW", "en-US"] }
    });
    expect(readStoredLocale()).toBe("zh-CN");
  });

  it("stores an explicit locale", () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", {
      localStorage: { setItem },
      navigator: { language: "en", languages: ["en"] }
    });
    writeStoredLocale("zh-CN");
    expect(setItem).toHaveBeenCalledWith(UI_LOCALE_STORAGE_KEY, "zh-CN");
  });
});

describe("localized errors", () => {
  it("localizes HTTP status fallbacks", () => {
    expect(apiStatusMessage("zh-CN", 403)).toBe(
      translate("zh-CN", "api.status.forbidden")
    );
    expect(apiStatusMessage("en", 404)).toBe(
      translate("en", "api.status.notFound")
    );
  });

  it("localizes semantic API codes and hides unknown English details in Chinese", () => {
    expect(
      localizeApiErrorDetail(
        "zh-CN",
        "auth_credentials_invalid",
        "Server wording may change",
        401
      )
    ).toBe(translate("zh-CN", "api.error.authCredentialsInvalid"));
    expect(
      localizeApiErrorDetail("zh-CN", "template_required", "Server wording", 409)
    ).toBe(translate("zh-CN", "api.error.templateRequired"));
    expect(
      localizeApiErrorDetail("zh-CN", "project_content_changed", "Server wording", 409)
    ).toBe(translate("zh-CN", "api.error.projectContentChanged"));
    expect(
      localizeApiErrorDetail(
        "zh-CN",
        "external_git_authorization_required",
        "Server wording",
        428
      )
    ).toBe(translate("zh-CN", "api.error.externalGitAuthorizationRequired"));
    expect(localizeApiErrorDetail("zh-CN", null, "Database exploded", 500)).toBe(
      apiStatusMessage("zh-CN", 500)
    );
    expect(localizeApiErrorDetail("en", null, "Database exploded", 500)).toBe("Database exploded");
  });

  it("localizes known browser runtime errors", () => {
    const knownError = "PDF export failed";
    const parameterizedError = "Canvas context is unavailable for Typst page 4";
    expect(localizeClientError("zh-CN", knownError)).not.toBe(knownError);
    expect(localizeClientError("zh-CN", parameterizedError)).not.toBe(
      parameterizedError
    );
    expect(localizeClientError("en", knownError)).toBe(knownError);
  });
});
