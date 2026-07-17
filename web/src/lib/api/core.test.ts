import { afterEach, describe, expect, it } from "vitest";
import {
  ApiError,
  authHeaders,
  parseApiErrorPayload,
  throwApiError
} from "@/lib/api/core";
import {
  PROTOCOL_EPOCH,
  PROTOCOL_EPOCH_HEADER,
  protocolCompatibilityState,
  resetProtocolCompatibilityForTest
} from "@/lib/protocolCompatibility";
afterEach(() => resetProtocolCompatibilityForTest());

describe("API error contract", () => {
  it("identifies browser requests with the coupled protocol epoch", () => {
    expect(authHeaders()[PROTOCOL_EPOCH_HEADER]).toBe(String(PROTOCOL_EPOCH));
  });

  it("parses the canonical structured error payload", () => {
    expect(
      parseApiErrorPayload({
        code: "auth_credentials_invalid",
        message: "Incorrect email or password"
      })
    ).toEqual({
      code: "auth_credentials_invalid",
      message: "Incorrect email or password"
    });
  });

  it("does not expose an unknown machine-readable code", () => {
    expect(
      parseApiErrorPayload({ code: "future_code", message: "Try again" })
    ).toEqual({ code: null, message: "Try again" });
  });

  it("preserves the status and contract code on thrown errors", async () => {
    const response = new Response(
      JSON.stringify({ code: "forbidden", message: "Permission denied" }),
      {
        status: 403,
        headers: { "content-type": "application/json" }
      }
    );

    await expect(throwApiError(response, "api.loadProjects")).rejects.toMatchObject({
      name: "ApiError",
      status: 403,
      code: "forbidden"
    } satisfies Partial<ApiError>);
  });

  it("marks an incompatible Core response before surfacing its API error", async () => {
    const response = new Response(
      JSON.stringify({ code: "client_incompatible", message: "Reload" }),
      {
        status: 426,
        headers: {
          "content-type": "application/json",
          [PROTOCOL_EPOCH_HEADER]: String(PROTOCOL_EPOCH + 1)
        }
      }
    );

    await expect(throwApiError(response, "api.loadProjects")).rejects.toBeInstanceOf(ApiError);
    expect(protocolCompatibilityState()).toBe("reload_required");
  });
});
