import { describe, expect, it } from "vitest";
import { allowedExternalUrl, allowedNetworkUrl, allowedWindowRequest } from "./permissions.js";

describe("host permissions", () => {
  it("accepts only exact HTTPS hostnames with default ports", () => {
    expect(allowedNetworkUrl("https://example.com:443/a", ["example.com"])?.href).toBe("https://example.com/a");
    for (const input of ["http://example.com", "https://sub.example.com", "https://example.com:444",
      "https://user@example.com", "https://example.com.", "https://127.0.0.1", "https://[::1]"]) {
      expect(allowedNetworkUrl(input, ["example.com", "127.0.0.1", "[::1]"])).toBeNull();
    }
  });

  it("uses normalized paths and a slash boundary for external URLs", () => {
    const patterns = ["https://example.com/a/*", "https://example.org/exact"];
    expect(allowedExternalUrl("https://example.com/a/x/../b?x=1#ok", patterns)?.href)
      .toBe("https://example.com/a/b?x=1#ok");
    expect(allowedExternalUrl("https://example.org/exact?q=1", patterns)).not.toBeNull();
    for (const input of ["https://example.com/a", "https://example.com/ab", "https://example.com/b/%2e%2e/a",
      "https://example.org/exacts", "https://example.org:444/exact", "https://u@example.org/exact"])
      expect(allowedExternalUrl(input, patterns)).toBeNull();
  });

  it("checks declared window ids and their initial URL", () => {
    const permissions = { windows: ["clock"], network: ["example.com"] };
    expect(allowedWindowRequest("clock", "https://example.com/start", permissions)).toBe(true);
    expect(allowedWindowRequest("other", "https://example.com/start", permissions)).toBe(false);
    expect(allowedWindowRequest("clock", "https://other.com", permissions)).toBe(false);
  });
});
