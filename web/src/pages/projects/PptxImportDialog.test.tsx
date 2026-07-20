// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  ButtonHTMLAttributes,
  ComponentProps,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes
} from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessingInputProfileSelector } from "@/lib/api";
import type { Translator } from "@/lib/i18n";
import { PptxImportDialog } from "@/pages/projects/PptxImportDialog";

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
  UiInput: ({
    label,
    ...props
  }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode }) => (
    <label>
      {label}
      <input {...props} />
    </label>
  ),
  UiSelect: ({
    label,
    children,
    ...props
  }: SelectHTMLAttributes<HTMLSelectElement> & { label?: ReactNode }) => (
    <label>
      {label}
      <select {...props}>{children}</select>
    </label>
  )
}));

const t: Translator = (key) => key;

const selector: ProcessingInputProfileSelector = {
  label: { en: "Profile", "zh-CN": "配置" },
  default_profile: "profile-a",
  profiles: [
    {
      id: "profile-a",
      label: { en: "Profile A", "zh-CN": "配置 A" },
      description: { en: "First profile", "zh-CN": "第一项" }
    },
    {
      id: "profile-b",
      label: { en: "Profile B", "zh-CN": "配置 B" },
      description: { en: "Second profile", "zh-CN": "第二项" }
    }
  ]
};

afterEach(() => cleanup());

function renderDialog(
  overrides: Partial<ComponentProps<typeof PptxImportDialog>> = {}
) {
  const onSubmit = vi.fn(async () => undefined);
  const onClose = vi.fn();
  render(
    <PptxImportDialog
      open
      state="available"
      reason={null}
      pending={false}
      error={null}
      inputProfileSelector={selector}
      locale="en"
      onClose={onClose}
      onSubmit={onSubmit}
      t={t}
      {...overrides}
    />
  );
  return { onClose, onSubmit };
}

function chooseFile() {
  const file = new File(["pptx"], "deck.pptx", {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  });
  fireEvent.change(screen.getByLabelText("processing.pptxFile"), {
    target: {
      files: {
        0: file,
        length: 1,
        item: (index: number) => (index === 0 ? file : null)
      }
    }
  });
  return file;
}

describe("PptxImportDialog", () => {
  it("submits the selected distribution profile", async () => {
    const { onClose, onSubmit } = renderDialog();
    const file = chooseFile();

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "profile-b" }
    });
    fireEvent.click(screen.getByRole("button", { name: "processing.importPptxAction" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(file, "profile-b"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("submits no profile when the capability has no selector", async () => {
    const { onSubmit } = renderDialog({ inputProfileSelector: null });
    const file = chooseFile();

    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "processing.importPptxAction" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(file, null));
  });

  it("uses a single profile without rendering a redundant selector", async () => {
    const singleProfileSelector: ProcessingInputProfileSelector = {
      ...selector,
      profiles: selector.profiles.filter((profile) => profile.id === "profile-a")
    };
    const { onSubmit } = renderDialog({
      inputProfileSelector: singleProfileSelector
    });
    const file = chooseFile();

    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "processing.importPptxAction" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(file, "profile-a"));
  });
});
