import { afterEach, describe, expect, it } from "bun:test";

import {
  buildGeminiCliUserAgent,
  getPluginVersion,
  _resetVersionCache,
} from "./user-agent";

const originalNpmPackageVersion = process.env.npm_package_version;

describe("user-agent", () => {
  afterEach(() => {
    if (originalNpmPackageVersion === undefined) {
      delete process.env.npm_package_version;
    } else {
      process.env.npm_package_version = originalNpmPackageVersion;
    }
    _resetVersionCache();
  });

  it("builds a transparent user agent with plugin identity", () => {
    delete process.env.npm_package_version;

    const userAgent = buildGeminiCliUserAgent("gemini-2.5-pro");
    expect(userAgent).toContain("OpencodeGeminiAuth/");
    expect(userAgent).toContain(`(${process.platform}; ${process.arch})`);
    // Should NOT contain GeminiCLI (no impersonation)
    expect(userAgent).not.toContain("GeminiCLI");
  });

  it("includes the plugin version when available", () => {
    _resetVersionCache();
    process.env.npm_package_version = "2.0.0-test";

    const userAgent = buildGeminiCliUserAgent("gemini-2.5-pro");
    expect(userAgent).toContain("OpencodeGeminiAuth/2.0.0-test");
  });

  it("uses the default model when none is provided", () => {
    delete process.env.npm_package_version;

    const userAgent = buildGeminiCliUserAgent();
    expect(userAgent).toContain("OpencodeGeminiAuth/");
  });
});
