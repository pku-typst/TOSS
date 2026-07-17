export const SERVICE_RESTART_CLOSE_CODE = 1012;

const FAST_RECONNECT_MIN_MS = 100;
const FAST_RECONNECT_JITTER_MS = 300;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 15_000;
const BACKOFF_MIN_FACTOR = 0.75;
const BACKOFF_JITTER_FACTOR = 0.5;

export function reconnectDelayMs(input: {
  attempt: number;
  closeCode?: number;
  overrideSeconds?: number;
  random?: () => number;
}): number {
  if (input.overrideSeconds !== undefined) {
    return Math.max(1, Math.floor(input.overrideSeconds)) * 1_000;
  }
  const random = input.random ?? Math.random;
  const sample = Math.max(0, Math.min(1, random()));
  if (input.closeCode === SERVICE_RESTART_CLOSE_CODE) {
    return Math.round(
      FAST_RECONNECT_MIN_MS + sample * FAST_RECONNECT_JITTER_MS,
    );
  }
  const attempt = Math.max(1, Math.floor(input.attempt));
  const exponential = Math.min(
    BACKOFF_MAX_MS,
    BACKOFF_BASE_MS * 2 ** Math.min(attempt - 1, 8),
  );
  return Math.min(
    BACKOFF_MAX_MS,
    Math.round(
      exponential *
        (BACKOFF_MIN_FACTOR + sample * BACKOFF_JITTER_FACTOR),
    ),
  );
}
