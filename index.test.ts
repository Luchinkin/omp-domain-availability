import { describe, expect, test } from "bun:test";
import { normalizeDomain, rdapServicesFromBootstrap } from "./index";

describe("normalizeDomain", () => {
  test("normalizes case and Unicode labels", () => {
    expect(normalizeDomain("BÜCHER.example")).toBe("xn--bcher-kva.example");
  });

  test("rejects URLs with paths and malformed labels", () => {
    expect(() => normalizeDomain("https://example.com/path")).toThrow("Invalid domain");
    expect(() => normalizeDomain("-bad.example")).toThrow("Invalid domain");
    expect(() => normalizeDomain("localhost")).toThrow("Invalid domain");
  });
});

describe("rdapServicesFromBootstrap", () => {
  test("distinguishes supported registries from unsupported TLDs", () => {
    const services = rdapServicesFromBootstrap({
      services: [
        [["ing"], ["https://pubapi.registry.google/rdap/"]],
        [["sh"], ["http://insecure.example/rdap/"]],
      ],
    });

    expect(services.get("ing")).toBe("https://pubapi.registry.google/rdap/");
    expect(services.has("sh")).toBeFalse();
  });
});
