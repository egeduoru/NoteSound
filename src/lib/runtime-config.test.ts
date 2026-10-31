import { describe, expect, it, vi } from "vitest";
import { getDiscoveryApiUrl, resolveDiscoveryApiUrl } from "./runtime-config";

describe("public release backend configuration", () => {
  it("lets a static release select its HTTPS backend without rebuilding", () => {
    expect(
      resolveDiscoveryApiUrl(
        { discoveryApiUrl: "  https://notesound-api.example.com/  " },
        "https://build-api.example.com",
      ),
    ).toBe("https://notesound-api.example.com");
  });

  it("reads the configuration loaded before the application script", () => {
    vi.stubGlobal("window", {
      NOTESOUND_CONFIG: { discoveryApiUrl: "https://runtime.example.com/" },
    });
    try {
      expect(getDiscoveryApiUrl()).toBe("https://runtime.example.com");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retains the configured build address when the editable value is empty", () => {
    expect(
      resolveDiscoveryApiUrl(
        { discoveryApiUrl: "" },
        "https://build.example.com/",
      ),
    ).toBe("https://build.example.com");
    expect(resolveDiscoveryApiUrl(undefined, "https://build.example.com")).toBe(
      "https://build.example.com",
    );
  });

  it.each([
    "http://public.example.com",
    "https://user:secret@example.com",
    "https://example.com?token=secret",
    "https://example.com#secret",
    "javascript:alert(1)",
    "//example.com",
    "not a url",
    42,
  ])("does not expose an unsafe or malformed override: %s", (value) => {
    expect(
      resolveDiscoveryApiUrl(
        { discoveryApiUrl: value },
        "https://build.example.com",
      ),
    ).toBe("https://build.example.com");
  });

  it("supports same-origin hosting and localhost development", () => {
    expect(resolveDiscoveryApiUrl({ discoveryApiUrl: "/" })).toBe("/");
    expect(
      resolveDiscoveryApiUrl({ discoveryApiUrl: "http://127.0.0.1:3002/" }),
    ).toBe("http://127.0.0.1:3002");
    expect(
      resolveDiscoveryApiUrl({ discoveryApiUrl: "http://localhost:3002" }),
    ).toBe("http://localhost:3002");
  });

  it("does not silently send production requests to localhost", () => {
    expect(resolveDiscoveryApiUrl({}, undefined, false)).toBe("");
    expect(resolveDiscoveryApiUrl({}, undefined, true)).toBe("/");
    expect(resolveDiscoveryApiUrl(null, "broken", false)).toBe("");
    expect(resolveDiscoveryApiUrl([], undefined, true)).toBe("/");
  });
});
