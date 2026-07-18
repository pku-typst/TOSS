import type {
  AiTypstPackageToolRequest,
  AiWorkspaceToolExecution
} from "@/features/ai/toolContract";
import type { TypstPackageSource } from "@/lib/typstUniverse";

export type TypstPackageInspectorExecute = {
  kind: "execute";
  id: number;
  source: TypstPackageSource;
  request: AiTypstPackageToolRequest;
};

export type TypstPackageInspectorCancel = {
  kind: "cancel";
  id: number;
};

export type TypstPackageInspectorRequest =
  | TypstPackageInspectorExecute
  | TypstPackageInspectorCancel;

export type TypstPackageInspectorResponse = {
  id: number;
  execution: AiWorkspaceToolExecution;
};
