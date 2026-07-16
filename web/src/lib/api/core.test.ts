import { describe, expect, it } from "vitest";
import {
  ApiError,
  parseApiErrorPayload,
  throwApiError
} from "@/lib/api/core";

describe("API error contract", () => {
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
});
