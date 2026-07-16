export type RuntimeDesignTheme = {
  colorScheme: "light";
  fontFamily: string;
  fontSizeCaption: string;
  fontSizeLabel: string;
  fontSize: string;
  lineHeightCompact: string;
  lineHeight: string;
  canvas: string;
  surface: string;
  surfaceSubtle: string;
  field: string;
  text: string;
  textMuted: string;
  textEmphasis: string;
  textPlaceholder: string;
  border: string;
  borderStrong: string;
  brand: string;
  brandHover: string;
  brandContrast: string;
  brandSubtle: string;
  danger: string;
  radiusControl: string;
  controlHeight: string;
  spaceXs: string;
  spaceSm: string;
};

export const DEFAULT_RUNTIME_DESIGN_THEME: RuntimeDesignTheme = {
  colorScheme: "light",
  fontFamily: "Inter, system-ui, sans-serif",
  fontSizeCaption: "10px",
  fontSizeLabel: "12px",
  fontSize: "14px",
  lineHeightCompact: "16px",
  lineHeight: "20px",
  canvas: "#f5f6f7",
  surface: "#ffffff",
  surfaceSubtle: "#f5f7f9",
  field: "#f5f7f9",
  text: "#252a34",
  textMuted: "#5c6470",
  textEmphasis: "#171a21",
  textPlaceholder: "#747d89",
  border: "#d7dce3",
  borderStrong: "#9da5b1",
  brand: "#2563eb",
  brandHover: "#1d4ed8",
  brandContrast: "#ffffff",
  brandSubtle: "#eff6ff",
  danger: "#b42318",
  radiusControl: "4px",
  controlHeight: "32px",
  spaceXs: "4px",
  spaceSm: "8px"
};

const RUNTIME_THEME_KEYS = Object.keys(DEFAULT_RUNTIME_DESIGN_THEME) as Array<
  keyof RuntimeDesignTheme
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeCssValue(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\0\r\n;{}<>]/.test(value);
}

export function isRuntimeDesignTheme(value: unknown): value is RuntimeDesignTheme {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...RUNTIME_THEME_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return false;
  }
  return value.colorScheme === "light" && RUNTIME_THEME_KEYS
    .filter((key) => key !== "colorScheme")
    .every((key) => isSafeCssValue(value[key]));
}

type ResolvedToken = {
  token: string;
  property: string;
  fallback: string;
};

const RESOLVED_THEME_TOKENS: Record<
  Exclude<keyof RuntimeDesignTheme, "colorScheme">,
  ResolvedToken
> = {
  fontFamily: {
    token: "--toss-font-family",
    property: "font-family",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.fontFamily
  },
  fontSizeCaption: {
    token: "--toss-font-size-caption",
    property: "font-size",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.fontSizeCaption
  },
  fontSizeLabel: {
    token: "--toss-font-size-label",
    property: "font-size",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.fontSizeLabel
  },
  fontSize: {
    token: "--toss-font-size-body",
    property: "font-size",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.fontSize
  },
  lineHeightCompact: {
    token: "--toss-line-height-compact",
    property: "line-height",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.lineHeightCompact
  },
  lineHeight: {
    token: "--toss-line-height-body",
    property: "line-height",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.lineHeight
  },
  canvas: {
    token: "--toss-canvas",
    property: "background-color",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.canvas
  },
  surface: {
    token: "--toss-surface",
    property: "background-color",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.surface
  },
  surfaceSubtle: {
    token: "--toss-surface-subtle",
    property: "background-color",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.surfaceSubtle
  },
  field: {
    token: "--toss-surface-field",
    property: "background-color",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.field
  },
  text: {
    token: "--toss-text",
    property: "color",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.text
  },
  textMuted: {
    token: "--toss-text-muted",
    property: "color",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.textMuted
  },
  textEmphasis: {
    token: "--toss-text-emphasis",
    property: "color",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.textEmphasis
  },
  textPlaceholder: {
    token: "--toss-text-placeholder",
    property: "color",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.textPlaceholder
  },
  border: {
    token: "--toss-border-subtle",
    property: "border-top-color",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.border
  },
  borderStrong: {
    token: "--toss-border-strong",
    property: "border-top-color",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.borderStrong
  },
  brand: {
    token: "--toss-brand-primary",
    property: "color",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.brand
  },
  brandHover: {
    token: "--toss-brand-hover",
    property: "color",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.brandHover
  },
  brandContrast: {
    token: "--toss-brand-contrast",
    property: "color",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.brandContrast
  },
  brandSubtle: {
    token: "--toss-brand-subtle",
    property: "color",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.brandSubtle
  },
  danger: {
    token: "--toss-danger",
    property: "color",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.danger
  },
  radiusControl: {
    token: "--toss-radius-control",
    property: "border-top-left-radius",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.radiusControl
  },
  controlHeight: {
    token: "--toss-control-height-md",
    property: "height",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.controlHeight
  },
  spaceXs: {
    token: "--toss-space-xs",
    property: "width",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.spaceXs
  },
  spaceSm: {
    token: "--toss-space-sm",
    property: "width",
    fallback: DEFAULT_RUNTIME_DESIGN_THEME.spaceSm
  }
};

function resolvedValue(
  probe: HTMLElement,
  { token, property, fallback }: ResolvedToken
) {
  probe.style.setProperty(property, `var(${token})`);
  const value = getComputedStyle(probe).getPropertyValue(property).trim();
  probe.style.removeProperty(property);
  return isSafeCssValue(value) && !value.includes("var(") ? value : fallback;
}

export function readRuntimeDesignTheme(
  root: HTMLElement = document.documentElement
): RuntimeDesignTheme {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") {
    return { ...DEFAULT_RUNTIME_DESIGN_THEME };
  }
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  (document.body ?? root).append(probe);
  try {
    const theme = { colorScheme: "light" } as RuntimeDesignTheme;
    for (const [key, descriptor] of Object.entries(RESOLVED_THEME_TOKENS) as Array<
      [Exclude<keyof RuntimeDesignTheme, "colorScheme">, ResolvedToken]
    >) {
      theme[key] = resolvedValue(probe, descriptor);
    }
    return theme;
  } finally {
    probe.remove();
  }
}

const RUNTIME_CSS_PROPERTIES: Record<keyof RuntimeDesignTheme, string> = {
  colorScheme: "color-scheme",
  fontFamily: "--toss-font-family",
  fontSizeCaption: "--toss-font-size-caption",
  fontSizeLabel: "--toss-font-size-label",
  fontSize: "--toss-font-size-body",
  lineHeightCompact: "--toss-line-height-compact",
  lineHeight: "--toss-line-height-body",
  canvas: "--toss-canvas",
  surface: "--toss-surface",
  surfaceSubtle: "--toss-surface-subtle",
  field: "--toss-surface-field",
  text: "--toss-text",
  textMuted: "--toss-text-muted",
  textEmphasis: "--toss-text-emphasis",
  textPlaceholder: "--toss-text-placeholder",
  border: "--toss-border-subtle",
  borderStrong: "--toss-border-strong",
  brand: "--toss-brand-primary",
  brandHover: "--toss-brand-hover",
  brandContrast: "--toss-brand-contrast",
  brandSubtle: "--toss-brand-subtle",
  danger: "--toss-danger",
  radiusControl: "--toss-radius-control",
  controlHeight: "--toss-control-height-md",
  spaceXs: "--toss-space-xs",
  spaceSm: "--toss-space-sm"
};

export function applyRuntimeDesignTheme(
  theme: RuntimeDesignTheme,
  root: HTMLElement = document.documentElement
) {
  for (const key of RUNTIME_THEME_KEYS) {
    root.style.setProperty(RUNTIME_CSS_PROPERTIES[key], theme[key]);
  }
}
