export function resolveBrowserFrontendFeatures({
  included,
  defaultEnabled,
  configured,
}: {
  included: readonly string[];
  defaultEnabled: readonly string[];
  configured: string | undefined;
}) {
  const selected =
    configured === undefined
      ? [...defaultEnabled]
      : configured.trim() === ""
        ? []
        : configured.split(",").map((feature) => feature.trim());

  if (selected.some((feature) => feature.length === 0)) {
    throw new Error("TOSS_BROWSER_ENABLED_FEATURES contains an empty feature");
  }

  const includedFeatures = new Set(included);
  const seen = new Set<string>();
  for (const feature of selected) {
    if (!includedFeatures.has(feature)) {
      throw new Error(
        `Browser frontend feature is not included by the distribution: ${feature}`,
      );
    }
    if (seen.has(feature)) {
      throw new Error(`Duplicate browser frontend feature: ${feature}`);
    }
    seen.add(feature);
  }

  return selected;
}
