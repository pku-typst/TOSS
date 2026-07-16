import { describe, expect, it } from "vitest";
import { formatRevisionRelativeTime } from "@/components/HistoryPanel";

describe("formatRevisionRelativeTime", () => {
  const now = Date.parse("2026-07-09T12:00:00Z");

  it("formats a recent revision in English", () => {
    expect(formatRevisionRelativeTime("2026-07-09T11:30:00Z", "en", now)).toBe("30 minutes ago");
  });

  it("formats a recent revision in Chinese", () => {
    expect(formatRevisionRelativeTime("2026-07-09T11:30:00Z", "zh-CN", now)).toBe("30分钟前");
  });

  it("returns the source value when the date is invalid", () => {
    expect(formatRevisionRelativeTime("not-a-date", "en", now)).toBe("not-a-date");
  });
});
