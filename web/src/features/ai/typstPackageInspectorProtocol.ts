import type {
  AiTypstPackageToolRequest,
  AiWorkspaceToolExecution
} from "@/features/ai/toolContract";

export type TypstPackageInspectorExecute = {
  kind: "execute";
  id: number;
  baseUrl: string;
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
