import {
  isAiRuntimeModelTokenBudget,
  type AiRuntimeManagedCatalogModel,
  type AiRuntimeManagedModelSelection
} from "@/features/ai/protocol";
import type { AiRuntimeServerPolicy } from "@/features/ai/runtimeConfig";

type ManagedPolicy = Extract<AiRuntimeServerPolicy, { kind: "managed_catalog" }>;

export function isManagedCustomSelectionAvailable(
  policy: ManagedPolicy,
  models: readonly AiRuntimeManagedCatalogModel[],
  selection: AiRuntimeManagedModelSelection
) {
  if (selection.kind !== "custom" || !policy.customProfiles.enabled) return false;
  const { limits } = policy.customProfiles;
  if (
    !isAiRuntimeModelTokenBudget(selection.contextWindow, selection.maxOutputTokens) ||
    selection.contextWindow < limits.minContextWindow ||
    selection.contextWindow > limits.maxContextWindow ||
    selection.maxOutputTokens < limits.minOutputTokens ||
    selection.maxOutputTokens > limits.maxOutputTokens
  ) return false;
  const model = models.find((candidate) => candidate.id === selection.model);
  if (policy.customProfiles.requireCatalogMatch && !model) return false;
  return !!model &&
    (model.maxInputTokens === undefined || selection.contextWindow <= model.maxInputTokens) &&
    (model.maxOutputTokens === undefined ||
      selection.maxOutputTokens <= model.maxOutputTokens);
}
