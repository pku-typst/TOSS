// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  PropsWithChildren,
  ReactNode,
  SelectHTMLAttributes
} from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProject, type Project } from "@/lib/api";
import type { Translator } from "@/lib/i18n";
import { ProjectsPage } from "@/pages/ProjectsPage";

vi.mock("@/lib/api", () => ({
  copyProject: vi.fn(),
  createProject: vi.fn(),
  projectThumbnailUrl: vi.fn(),
  renameProject: vi.fn(),
  setProjectArchived: vi.fn()
}));

vi.mock("@/components/ui", () => ({
  UiBadge: ({ children }: PropsWithChildren) => <span>{children}</span>,
  UiButton: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
  UiCard: ({ children }: PropsWithChildren) => <div>{children}</div>,
  UiDialog: ({
    open,
    children,
    actions
  }: PropsWithChildren<{ open: boolean; actions?: ReactNode }>) =>
    open ? (
      <div>
        {children}
        {actions}
      </div>
    ) : null,
  UiIconButton: ({
    children,
    tooltip: _tooltip,
    label,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { tooltip: string; label: string }) => (
    <button {...props} aria-label={label}>{children}</button>
  ),
  UiInput: ({
    label,
    error,
    ...props
  }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode; error?: ReactNode }) => (
    <label>
      {label}
      <input {...props} />
      {error && <span role="alert">{error}</span>}
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

vi.mock("@/pages/projects/ExternalGitImportDialog", () => ({
  ExternalGitImportDialog: () => null
}));

const t: Translator = (key) => key;

const existingProject: Project = {
  archived: false,
  archived_at: null,
  can_read: true,
  created_at: "2026-07-13T00:00:00Z",
  has_thumbnail: false,
  id: "project-a",
  is_template: false,
  last_edited_at: "2026-07-13T00:00:00Z",
  latex_engine: null,
  my_role: "Owner",
  name: "quarterly-review",
  owner_display_name: "user-a",
  owner_user_id: "user-a",
  project_type: "typst"
};

function renderPage(projects: Project[] = []) {
  render(
    <MemoryRouter>
      <ProjectsPage
        projects={projects}
        organizations={[]}
        enabledProjectTypes={["typst"]}
        externalGitProviders={[]}
        refreshProjects={vi.fn().mockResolvedValue(undefined)}
        locale="en"
        t={t}
      />
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProjectsPage", () => {
  it("shows and focuses the project-name error instead of silently ignoring creation", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "projects.createAction" }));

    expect(createProject).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("projects.nameRequired");
    expect(document.activeElement).toBe(screen.getByPlaceholderText("projects.namePlaceholder"));
  });

  it("rejects a visible duplicate name without making a creation request", () => {
    renderPage([existingProject]);
    const nameInput = screen.getByPlaceholderText("projects.namePlaceholder");
    fireEvent.change(nameInput, { target: { value: "  QUARTERLY-REVIEW  " } });

    fireEvent.click(screen.getByRole("button", { name: "projects.createAction" }));

    expect(createProject).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("projects.nameDuplicate");
    expect(document.activeElement).toBe(nameInput);
  });
});
