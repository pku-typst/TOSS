import type { CustomElements } from "@nvidia-elements/core/custom-elements-jsx";
import type { HTMLAttributes } from "react";

declare module "react" {
  interface HTMLAttributes<T> {
    "nve-layout"?: string;
    "nve-text"?: string;
    "nve-display"?: string;
    "nve-theme"?: string;
  }
}

type ReactCustomElements = {
  [Tag in keyof CustomElements]: Omit<CustomElements[Tag], keyof HTMLAttributes<HTMLElement>> &
    HTMLAttributes<HTMLElement>;
};

declare module "react/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements extends ReactCustomElements {}
  }
}
