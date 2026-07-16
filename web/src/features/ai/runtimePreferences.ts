export type AiRuntimePreferences = {
  providerRequestTimeoutMs: number;
  maxProviderCallsPerTurn: number;
  maxTurnMs: number;
  catalogRequestTimeoutMs: number;
};

export const DEFAULT_AI_RUNTIME_PREFERENCES: AiRuntimePreferences = {
  providerRequestTimeoutMs: 120_000,
  maxProviderCallsPerTurn: 12,
  maxTurnMs: 300_000,
  catalogRequestTimeoutMs: 20_000
};

export function isAiRuntimePreferences(value: unknown): value is AiRuntimePreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [
    "providerRequestTimeoutMs",
    "maxProviderCallsPerTurn",
    "maxTurnMs",
    "catalogRequestTimeoutMs"
  ].sort();
  const exact = actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
  const integerBetween = (candidate: unknown, minimum: number, maximum: number) =>
    Number.isSafeInteger(candidate) && Number(candidate) >= minimum && Number(candidate) <= maximum;
  return exact &&
    integerBetween(record.providerRequestTimeoutMs, 10_000, 300_000) &&
    integerBetween(record.maxProviderCallsPerTurn, 1, 32) &&
    integerBetween(record.maxTurnMs, 30_000, 900_000) &&
    Number(record.maxTurnMs) >= Number(record.providerRequestTimeoutMs) &&
    integerBetween(record.catalogRequestTimeoutMs, 5_000, 120_000);
}
