import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UI_LOCALE_STORAGE_KEY,
  apiStatusMessage,
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

  it("translates and interpolates named values", () => {
    expect(translate("en", "preview.pageIndicator", { current: 2, total: 3 })).toBe("page 2/3");
    expect(translate("zh-CN", "preview.pageIndicator", { current: 2, total: 3 })).toBe("第 2/3 页");
  });

  it("falls back to English and preserves missing interpolation values", () => {
    expect(translate("zh-CN", "missing.key")).toBe("missing.key");
    expect(translate("en", "workspace.actionsFor")).toBe("Actions for {name}");
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
    expect(apiStatusMessage("zh-CN", 403)).toBe("没有权限");
    expect(apiStatusMessage("en", 404)).toBe("Resource not found");
  });

  it("localizes semantic API codes and hides unknown English details in Chinese", () => {
    expect(
      localizeApiErrorDetail(
        "zh-CN",
        "auth_credentials_invalid",
        "Server wording may change",
        401
      )
    ).toBe("邮箱或密码不正确");
    expect(
      localizeApiErrorDetail("zh-CN", "template_publication_required", "Server wording", 409)
    ).toBe("请先将项目发布为模板");
    expect(
      localizeApiErrorDetail("zh-CN", "project_content_changed", "Server wording", 409)
    ).toBe("项目内容已变更，请刷新后重试");
    expect(
      localizeApiErrorDetail(
        "zh-CN",
        "external_git_authorization_required",
        "Server wording",
        428
      )
    ).toBe("请连接或重新授权外部 Git 提供商");
    expect(localizeApiErrorDetail("zh-CN", null, "Database exploded", 500)).toBe("服务器错误");
    expect(localizeApiErrorDetail("en", null, "Database exploded", 500)).toBe("Database exploded");
  });

  it("localizes known browser runtime errors", () => {
    expect(localizeClientError("zh-CN", "PDF export failed")).toBe("PDF 导出失败");
    expect(localizeClientError("zh-CN", "LaTeX compile file is too large")).toBe(
      "LaTeX 编译文件过大"
    );
    expect(localizeClientError("zh-CN", "Canvas context is unavailable for Typst page 4")).toBe(
      "Typst 第 4 页的 Canvas 上下文不可用"
    );
  });
});
