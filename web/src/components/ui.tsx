import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type AriaRole,
  type ComponentPropsWithRef,
  type FocusEvent,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes
} from "react";
import { CircleHelp } from "lucide-react";
import type { Dialog } from "@nvidia-elements/core/dialog";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";
type UiButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value"> & {
  value?: string;
};

export function UiButton({
  variant = "secondary",
  size = "md",
  className = "",
  children,
  ...props
}: UiButtonProps & { variant?: ButtonVariant; size?: ButtonSize }) {
  const container = variant === "ghost" ? "flat" : undefined;
  const interaction =
    variant === "primary" ? "emphasis" : variant === "danger" ? "destructive" : undefined;
  return (
    <nve-button
      {...props}
      role={props.role ?? "button"}
      aria-disabled={props.disabled || undefined}
      container={container}
      interaction={interaction}
      size={size}
      selected={className.split(/\s+/).includes("active")}
      pressed={className.split(/\s+/).includes("active")}
      className={`ui-button ui-${variant} ui-${size} ${className}`.trim()}
    >
      {children}
    </nve-button>
  );
}

export function UiIconButton({
  tooltip,
  label,
  className = "",
  children,
  ...props
}: UiButtonProps & {
  tooltip: string;
  label: string;
}) {
  return (
    <UiTooltip content={tooltip}>
      <nve-icon-button
        {...props}
        role={props.role ?? "button"}
        aria-disabled={props.disabled || undefined}
        aria-label={label}
        container="flat"
        size="sm"
        pressed={className.split(/\s+/).includes("active")}
        className={`ui-icon-button ${className}`.trim()}
      >
        {children}
      </nve-icon-button>
    </UiTooltip>
  );
}

export function UiInput({
  className = "",
  label,
  error,
  ...props
}: ComponentPropsWithRef<"input"> & { label?: ReactNode; error?: ReactNode }) {
  const messageId = useId();
  const describedBy = [props["aria-describedby"], error ? messageId : undefined]
    .filter(Boolean)
    .join(" ") || undefined;
  return (
    <nve-input className={`ui-input ${className}`.trim()} status={error ? "error" : undefined}>
      {label !== undefined && <label>{label}</label>}
      <input
        {...props}
        aria-describedby={describedBy}
        aria-invalid={error ? true : props["aria-invalid"]}
      />
      {error !== undefined && error !== null && (
        <nve-control-message id={messageId} status="error" role="alert">
          {error}
        </nve-control-message>
      )}
    </nve-input>
  );
}

export function UiSelect({
  className = "",
  children,
  label,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label?: ReactNode }) {
  return (
    <nve-select className={`ui-select ${className}`.trim()}>
      {label !== undefined && <label>{label}</label>}
      <select {...props}>{children}</select>
    </nve-select>
  );
}

export function UiCheckbox({
  label,
  className = "",
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: ReactNode;
}) {
  return (
    <nve-checkbox className={`ui-checkbox ${className}`.trim()}>
      <label>{label}</label>
      <input {...props} type="checkbox" />
    </nve-checkbox>
  );
}

export function UiTooltip({
  content,
  children,
  className = "",
  triggerTabIndex,
  triggerAriaLabel,
  triggerRole
}: {
  content: string;
  children: ReactNode;
  className?: string;
  triggerTabIndex?: number;
  triggerAriaLabel?: string;
  triggerRole?: AriaRole;
}) {
  const reactId = useId();
  const triggerId = `ui-tooltip-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const tooltipRef = useRef<HTMLElement | null>(null);

  function showTooltip() {
    if (tooltipRef.current) tooltipRef.current.hidden = false;
  }

  function hideTooltip(event: FocusEvent<HTMLSpanElement>) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    if (tooltipRef.current) tooltipRef.current.hidden = true;
  }

  return (
    <span className={`ui-tooltip ${className}`.trim()}>
      <span
        id={triggerId}
        className="ui-tooltip-trigger"
        tabIndex={triggerTabIndex}
        aria-label={triggerAriaLabel}
        role={triggerRole}
        onFocusCapture={showTooltip}
        onBlurCapture={hideTooltip}
      >
        {children}
      </span>
      <nve-tooltip
        ref={(node: unknown) => {
          tooltipRef.current = node as HTMLElement | null;
        }}
        trigger={triggerId}
        position="top"
        alignment="center"
        behavior-trigger
        hidden
      >
        {content}
      </nve-tooltip>
    </span>
  );
}

export function UiHelpTooltip({ content, className = "" }: { content: string; className?: string }) {
  return (
    <UiTooltip
      content={content}
      className={`ui-help-tooltip ${className}`.trim()}
      triggerTabIndex={0}
      triggerAriaLabel={content}
      triggerRole="button"
    >
      <span className="ui-help-button">
        <CircleHelp size={15} aria-hidden />
      </span>
    </UiTooltip>
  );
}

export function UiBadge({
  tone = "neutral",
  children,
  className = "",
  title
}: {
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const status = tone === "neutral" ? undefined : tone === "accent" ? "accent" : tone;
  return (
    <nve-badge
      status={status}
      color={tone === "neutral" ? "gray-slate" : undefined}
      title={title}
      className={`ui-badge ui-badge-${tone} ${className}`.trim()}
    >
      {children}
    </nve-badge>
  );
}

export function UiDialog({
  open,
  title,
  description,
  onClose,
  children,
  actions
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const dialogRef = useRef<Dialog | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const handleClose = () => onClose();
    dialog.addEventListener("close", handleClose);
    if (!dialog.matches(":popover-open")) {
      dialog.showPopover();
    }
    return () => {
      dialog.removeEventListener("close", handleClose);
    };
  }, [onClose, open]);

  if (!open) return null;
  return (
    <nve-dialog
      ref={(node: unknown) => {
        dialogRef.current = node as Dialog | null;
      }}
      className="ui-dialog"
      role="dialog"
      modal
      closable
      aria-modal="true"
      aria-label={title}
    >
      <nve-dialog-header>
        <div className="ui-dialog-header">
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
      </nve-dialog-header>
      <div className="ui-dialog-body">{children}</div>
      {actions && (
        <nve-dialog-footer>
          <div className="ui-dialog-actions">{actions}</div>
        </nve-dialog-footer>
      )}
    </nve-dialog>
  );
}

export function UiCard({
  children,
  className = "",
  contentLayout = "column gap:md pad:lg align:horizontal-stretch",
  ...cardProps
}: HTMLAttributes<HTMLDivElement> & { contentLayout?: string }) {
  return (
    <nve-card {...cardProps} className={`ui-card ${className}`.trim()}>
      <nve-card-content nve-layout={contentLayout} className="ui-card-layout">
        {children}
      </nve-card-content>
    </nve-card>
  );
}
