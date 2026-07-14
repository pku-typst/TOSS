export type AssetHydrationProgressState = {
  active: boolean;
  loaded: number;
  total: number;
  loadedBytes: number;
  totalBytes: number;
};

export function createAssetHydrationProgressState(
  input?: Partial<AssetHydrationProgressState>
): AssetHydrationProgressState {
  return {
    active: false,
    loaded: 0,
    total: 0,
    loadedBytes: 0,
    totalBytes: 0,
    ...(input ?? {})
  };
}
