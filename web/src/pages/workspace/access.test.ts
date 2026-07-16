import { describe, expect, it } from "vitest";
import type { Translator } from "@/lib/i18n";
import { formatAccessSource } from "@/pages/workspace/access";

const translate: Translator = (key, values) =>
  values?.name ? `${key}:${String(values.name)}` : key;

describe("formatAccessSource", () => {
  it("formats every tagged access-source variant without parsing strings", () => {
    expect(formatAccessSource({ kind: "direct_role" }, translate)).toBe(
      "settings.sourceDirect"
    );
    expect(formatAccessSource({ kind: "share_link_invite" }, translate)).toBe(
      "settings.sourceShareLink"
    );
    expect(
      formatAccessSource(
        { kind: "organization", name: "NV Docs" },
        translate
      )
    ).toBe("settings.sourceOrganization:NV Docs");
  });
});
