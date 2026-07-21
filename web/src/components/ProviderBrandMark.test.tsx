// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ProviderBrandMark,
  type ProviderBrand
} from "@/components/ProviderBrandMark";

describe("ProviderBrandMark", () => {
  it("maps each repository brand to its explicit official asset", () => {
    const brands: ProviderBrand[] = [
      "github",
      "gitlab",
      "gitea",
      "forgejo",
      "codeberg"
    ];
    const { container } = render(
      <>
        {brands.map((brand) => (
          <ProviderBrandMark brand={brand} key={brand} />
        ))}
      </>
    );
    const sources = new Set<string>();

    for (const brand of brands) {
      const mark = container.querySelector(`[data-provider-logo="${brand}"]`);
      const image = mark?.querySelector("img");
      expect(mark?.getAttribute("data-provider-brand")).toBe(brand);
      expect(image?.getAttribute("src")).toMatch(/^data:image\/svg\+xml,/);
      expect(image?.getAttribute("alt")).toBe("");
      sources.add(image?.getAttribute("src") ?? "");
    }
    expect(sources.size).toBe(brands.length);
  });

  it("keeps generic identity visually explicit without guessing a vendor", () => {
    const { container } = render(<ProviderBrandMark brand="identity" size={24} />);
    const mark = container.querySelector('[data-provider-logo="identity"]');

    expect(mark?.querySelector("img")).toBeNull();
    expect(mark?.querySelector("svg")).not.toBeNull();
    expect(mark?.getAttribute("style")).toContain("24px");
  });
});
