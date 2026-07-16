// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyRuntimeDesignTheme,
  DEFAULT_RUNTIME_DESIGN_THEME,
  isRuntimeDesignTheme,
  readRuntimeDesignTheme
} from "@/design/runtimeTheme";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("portable runtime design theme", () => {
  it("resolves host tokens and removes its measurement element", () => {
    const resolved = new Map([
      ["--toss-brand-primary", "rgb(12, 34, 56)"],
      ["--toss-radius-control", "6px"],
      ["--toss-control-height-md", "36px"]
    ]);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => ({
      getPropertyValue(property: string) {
        const declaration = (element as HTMLElement).style.getPropertyValue(property);
        const token = declaration.match(/var\((--[^)]+)\)/)?.[1];
        return token ? resolved.get(token) ?? "" : "";
      }
    }) as CSSStyleDeclaration);

    const childCount = document.body.childElementCount;
    const theme = readRuntimeDesignTheme();

    expect(theme.brand).toBe("rgb(12, 34, 56)");
    expect(theme.radiusControl).toBe("6px");
    expect(theme.controlHeight).toBe("36px");
    expect(theme.surface).toBe(DEFAULT_RUNTIME_DESIGN_THEME.surface);
    expect(document.body.childElementCount).toBe(childCount);
  });

  it("validates the exact shape before applying known properties", () => {
    expect(isRuntimeDesignTheme(DEFAULT_RUNTIME_DESIGN_THEME)).toBe(true);
    expect(isRuntimeDesignTheme({
      ...DEFAULT_RUNTIME_DESIGN_THEME,
      brand: "red; display: none"
    })).toBe(false);
    expect(isRuntimeDesignTheme({
      ...DEFAULT_RUNTIME_DESIGN_THEME,
      arbitraryRule: "display: none"
    })).toBe(false);

    applyRuntimeDesignTheme({
      ...DEFAULT_RUNTIME_DESIGN_THEME,
      brand: "#123456",
      controlHeight: "34px"
    });
    expect(document.documentElement.style.getPropertyValue("--toss-brand-primary")).toBe("#123456");
    expect(document.documentElement.style.getPropertyValue("--toss-control-height-md")).toBe("34px");
  });
});
