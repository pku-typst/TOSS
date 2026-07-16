import { describe, expect, it } from "vitest";
import type { TemplateGalleryItem } from "@/lib/api";
import { filterGalleryTemplates, localizedTemplateText } from "@/lib/galleryUtils";

function template(
  id: string,
  source: TemplateGalleryItem["source"],
  overrides: Partial<TemplateGalleryItem> = {}
): TemplateGalleryItem {
  return {
    id,
    source,
    project_id: source === "builtin" ? null : id,
    name: { en: id, "zh-CN": `中文 ${id}` },
    description: { en: `Description ${id}`, "zh-CN": `描述 ${id}` },
    category: "presentation",
    tags: ["slides"],
    project_type: "typst",
    owner_display_name: null,
    featured: false,
    can_edit: source === "personal",
    can_read: true,
    has_thumbnail: false,
    updated_at: null,
    accent_color: "#76b900",
    ...overrides
  };
}

describe("template gallery utilities", () => {
  it("uses the requested localized text", () => {
    expect(localizedTemplateText({ en: "Report", "zh-CN": "报告" }, "zh-CN")).toBe("报告");
  });

  it("filters across localized metadata and source", () => {
    const templates = [
      template("deck", "builtin"),
      template("report", "personal", { tags: ["季度报告"] }),
      template("shared", "shared")
    ];
    expect(
      filterGalleryTemplates(templates, {
        locale: "zh-CN",
        query: "季度",
        source: "personal",
        category: "all"
      }).map((item) => item.id)
    ).toEqual(["report"]);
  });

  it("orders featured templates first and keeps built-ins ahead of custom templates", () => {
    const templates = [
      template("shared", "shared"),
      template("personal", "personal"),
      template("builtin", "builtin"),
      template("featured", "shared", { featured: true })
    ];
    expect(
      filterGalleryTemplates(templates, {
        locale: "en",
        query: "",
        source: "all",
        category: "all"
      }).map((item) => item.id)
    ).toEqual(["featured", "builtin", "personal", "shared"]);
  });
});
