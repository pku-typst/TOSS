// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UiButton } from "@/components/ui";

afterEach(cleanup);

describe("UiButton", () => {
  it("serializes boolean ARIA state for the custom-element host", () => {
    const { container, rerender } = render(<UiButton aria-pressed disabled />);

    const button = container.querySelector("nve-button");
    expect(button).not.toBeNull();
    if (!button) return;
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");

    rerender(<UiButton aria-pressed={false} />);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.hasAttribute("aria-disabled")).toBe(false);
  });
});
