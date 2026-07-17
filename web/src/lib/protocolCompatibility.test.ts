// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_EPOCH,
  PROTOCOL_EPOCH_HEADER,
  PROTOCOL_INCOMPATIBLE_CLOSE_CODE,
  appendProtocolEpoch,
  handleLazyChunkLoadFailure,
  isProtocolIncompatibleClose,
  observeProtocolResponse,
  protocolCompatibilityState,
  protocolEpochHeaders,
  requireProtocolReload,
  resetProtocolCompatibilityForTest,
  subscribeProtocolCompatibility
} from "@/lib/protocolCompatibility";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.head.replaceChildren();
  resetProtocolCompatibilityForTest();
});

describe("browser/Core protocol compatibility", () => {
  it("adds the one protocol epoch to REST and realtime requests", () => {
    expect(protocolEpochHeaders({ accept: "application/json" })).toEqual({
      accept: "application/json",
      [PROTOCOL_EPOCH_HEADER]: String(PROTOCOL_EPOCH)
    });
    const query = new URLSearchParams();
    appendProtocolEpoch(query);
    expect(query.get("protocol_epoch")).toBe(String(PROTOCOL_EPOCH));
  });

  it("owns one monotonic reload-required state", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeProtocolCompatibility(listener);

    requireProtocolReload();
    requireProtocolReload();

    expect(protocolCompatibilityState()).toBe("reload_required");
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("requires reload for an explicit mismatch but tolerates an absent legacy response header", () => {
    observeProtocolResponse(new Response(null, { status: 204 }));
    expect(protocolCompatibilityState()).toBe("compatible");

    observeProtocolResponse(
      new Response(null, {
        status: 204,
        headers: { [PROTOCOL_EPOCH_HEADER]: String(PROTOCOL_EPOCH + 1) }
      })
    );
    expect(protocolCompatibilityState()).toBe("reload_required");
  });

  it("recognizes only the reserved realtime incompatibility close code", () => {
    expect(isProtocolIncompatibleClose(PROTOCOL_INCOMPATIBLE_CLOSE_CODE)).toBe(true);
    expect(isProtocolIncompatibleClose(1012)).toBe(false);
  });

  it("tolerates a transient preload failure when the same Web build recovers", async () => {
    vi.useFakeTimers();
    document.head.innerHTML =
      '<script type="module" src="/assets/index-current.js"></script>';
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError("offline"))
        .mockResolvedValueOnce(
          new Response('<script type="module" src="/assets/index-current.js"></script>', {
            status: 200
          })
        )
    );
    const event = new Event("vite:preloadError", { cancelable: true });

    const handled = handleLazyChunkLoadFailure(event);
    await vi.advanceTimersByTimeAsync(500);
    await handled;

    expect(event.defaultPrevented).toBe(true);
    expect(protocolCompatibilityState()).toBe("compatible");
  });

  it("requires reload when preload recovery exposes another Web build", async () => {
    document.head.innerHTML =
      '<script type="module" src="/assets/index-previous.js"></script>';
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('<script type="module" src="/assets/index-current.js"></script>', {
          status: 200
        })
      )
    );
    const event = new Event("vite:preloadError", { cancelable: true });

    await handleLazyChunkLoadFailure(event);

    expect(protocolCompatibilityState()).toBe("reload_required");
  });

  it("requires reload when the current Web build cannot be identified", async () => {
    const event = new Event("vite:preloadError", { cancelable: true });

    await handleLazyChunkLoadFailure(event);

    expect(event.defaultPrevented).toBe(true);
    expect(protocolCompatibilityState()).toBe("reload_required");
  });

  it("bounds preload recovery when the Web entry remains unavailable", async () => {
    vi.useFakeTimers();
    document.head.innerHTML =
      '<script type="module" src="/assets/index-current.js"></script>';
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const event = new Event("vite:preloadError", { cancelable: true });

    const handled = handleLazyChunkLoadFailure(event);
    await vi.advanceTimersByTimeAsync(5_000);
    await handled;

    expect(protocolCompatibilityState()).toBe("reload_required");
  });
});
