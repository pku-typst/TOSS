// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AssistantMarkdown } from "@/features/ai/AssistantMarkdown";

describe("AssistantMarkdown", () => {
  it("renders baseline inline and display math with KaTeX and MathML", () => {
    const { container } = render(
      <AssistantMarkdown>{String.raw`
Inline $E = mc^2$.

$$
\int_0^1 x^2 \, dx = \frac{1}{3}
$$
      `}</AssistantMarkdown>
    );

    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(container.querySelectorAll("math")).toHaveLength(2);
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });

  it("leaves math delimiters inside inline and fenced code untouched", () => {
    const { container } = render(
      <AssistantMarkdown>{[
        "Use `$x$` literally.",
        "",
        "```typst",
        "$ x^2 $",
        "```"
      ].join("\n")}</AssistantMarkdown>
    );

    expect(container.querySelector(".katex")).toBeNull();
    expect(screen.getByText("$x$")).toBeInstanceOf(HTMLElement);
    expect(screen.getByText("$ x^2 $")).toBeInstanceOf(HTMLElement);
  });

  it("does not create trusted links from model-provided math", () => {
    const { container } = render(
      <AssistantMarkdown>{String.raw`$\href{https://example.com}{x}$`}</AssistantMarkdown>
    );

    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  it("keeps ordinary external Markdown links isolated", () => {
    render(<AssistantMarkdown>[Example](https://example.com)</AssistantMarkdown>);

    expect(screen.getByRole("link", { name: "Example" })).toMatchObject({
      target: "_blank",
      rel: "noreferrer"
    });
  });
});
