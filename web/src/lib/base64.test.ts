import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "@/lib/base64";

describe("base64 byte conversion", () => {
  it("round trips binary data larger than one conversion chunk", () => {
    const input = Uint8Array.from(
      { length: 0x8000 + 17 },
      (_, index) => index % 256
    );

    expect(base64ToBytes(bytesToBase64(input))).toEqual(input);
  });
});
