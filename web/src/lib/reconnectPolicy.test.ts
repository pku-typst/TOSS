import { describe, expect, it } from "vitest";
import {
  reconnectDelayMs,
  SERVICE_RESTART_CLOSE_CODE,
} from "@/lib/reconnectPolicy";

describe("realtime reconnect policy", () => {
  it("uses a short jittered delay for an explicit service restart", () => {
    expect(
      reconnectDelayMs({
        attempt: 7,
        closeCode: SERVICE_RESTART_CLOSE_CODE,
        random: () => 0,
      }),
    ).toBe(100);
    expect(
      reconnectDelayMs({
        attempt: 7,
        closeCode: SERVICE_RESTART_CLOSE_CODE,
        random: () => 1,
      }),
    ).toBe(400);
  });

  it("backs off abnormal disconnects with a bounded jitter", () => {
    expect(reconnectDelayMs({ attempt: 1, random: () => 0 })).toBe(750);
    expect(reconnectDelayMs({ attempt: 2, random: () => 0.5 })).toBe(2_000);
    expect(reconnectDelayMs({ attempt: 20, random: () => 1 })).toBe(15_000);
  });

  it("retains a deterministic override for focused transport tests", () => {
    expect(
      reconnectDelayMs({
        attempt: 20,
        closeCode: SERVICE_RESTART_CLOSE_CODE,
        overrideSeconds: 2,
      }),
    ).toBe(2_000);
  });
});
