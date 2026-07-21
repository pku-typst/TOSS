// @vitest-environment jsdom

import {
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import type {
  ButtonHTMLAttributes,
  ComponentProps,
  InputHTMLAttributes,
  ReactNode
} from "react";
import { describe, expect, it, vi } from "vitest";
import type { Translator } from "@/lib/i18n";
import { RevisionsPanel } from "@/pages/workspace/components/RevisionsPanel";

vi.mock("@/components/ui", () => ({
  UiButton: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  UiDialog: ({
    open,
    title,
    children,
    actions
  }: {
    open: boolean;
    title: string;
    children?: ReactNode;
    actions?: ReactNode;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
        {actions}
      </div>
    ) : null,
  UiIconButton: ({
    children,
    label,
    tooltip: _tooltip,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    label: string;
    tooltip: string;
  }) => (
    <button {...props} aria-label={label}>
      {children}
    </button>
  ),
  UiInput: ({
    label,
    error,
    ...props
  }: InputHTMLAttributes<HTMLInputElement> & {
    label?: ReactNode;
    error?: ReactNode;
  }) => (
    <label>
      {label}
      <input {...props} />
      {error ? <span role="alert">{error}</span> : null}
    </label>
  )
}));

vi.mock("@/components/HistoryPanel", () => ({
  HistoryPanel: () => <div data-testid="history-panel" />
}));

const t: Translator = (key) => key;

function renderPanel(
  overrides: Partial<ComponentProps<typeof RevisionsPanel>> = {}
) {
  const onCreateRevision = vi.fn(async () => undefined);
  render(
    <RevisionsPanel
      width={280}
      revisions={[]}
      activeRevisionId={null}
      loading={false}
      loadingRevisionId={null}
      loadingBytes={0}
      loadingTotalBytes={null}
      hasMore={false}
      loadingMore={false}
      canWrite
      isRevisionMode={false}
      onCreateRevision={onCreateRevision}
      onOpenRevision={vi.fn()}
      onLoadMore={vi.fn()}
      locale="en"
      t={t}
      {...overrides}
    />
  );
  return { onCreateRevision };
}

describe("RevisionsPanel", () => {
  it("creates a trimmed named snapshot from the header action", async () => {
    const { onCreateRevision } = renderPanel();

    fireEvent.click(
      screen.getByRole("button", { name: "revisions.create" })
    );
    const summary = screen.getByLabelText("revisions.summaryLabel");
    fireEvent.change(summary, { target: { value: "  snapshot fixture  " } });
    fireEvent.click(
      screen.getByRole("button", { name: "revisions.createAction" })
    );

    await waitFor(() =>
      expect(onCreateRevision).toHaveBeenCalledWith("snapshot fixture")
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "revisions.createTitle" })
      ).toBeNull()
    );
  });

  it("keeps the dialog open and reports creation failures", async () => {
    renderPanel({
      onCreateRevision: vi.fn(async () => {
        throw new Error("snapshot failed");
      })
    });

    fireEvent.click(
      screen.getByRole("button", { name: "revisions.create" })
    );
    fireEvent.change(screen.getByLabelText("revisions.summaryLabel"), {
      target: { value: "snapshot fixture" }
    });
    fireEvent.click(
      screen.getByRole("button", { name: "revisions.createAction" })
    );

    expect((await screen.findByRole("alert")).textContent).toBe("snapshot failed");
    expect(
      screen.getByRole("dialog", { name: "revisions.createTitle" })
    ).not.toBeNull();
  });

  it("does not expose snapshot creation to read-only members", () => {
    renderPanel({ canWrite: false });

    expect(
      screen.queryByRole("button", { name: "revisions.create" })
    ).toBeNull();
  });

  it("disables creation while viewing a historical revision", () => {
    renderPanel({ isRevisionMode: true });

    const button = screen.getByRole("button", {
      name: "revisions.create"
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
