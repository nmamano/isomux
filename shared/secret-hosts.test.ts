import { describe, expect, it } from "bun:test";

import {
  SECRET_PRESETS,
  checkSecretHosts,
  isNeverListed,
  isValidSecretHost,
} from "./secret-hosts.ts";

describe("isNeverListed", () => {
  it("normalizes case, a trailing dot, a port and a wildcard before it compares", () => {
    for (const host of [
      "api.openai.com",
      "API.OPENAI.COM",
      "api.openai.com.",
      "api.openai.com:443",
      "*.openai.com",
      "foo.anthropic.com",
      "claude.ai",
      "chatgpt.com",
      "my-resource.openai.azure.com",
      "aiplatform.googleapis.com",
      "europe-west4-aiplatform.googleapis.com",
      "generativelanguage.googleapis.com",
      "bedrock-runtime.us-east-1.amazonaws.com",
      "bedrock.eu-central-1.amazonaws.com",
      "registry.npmjs.org",
      "files.pythonhosted.org",
      "proxy.golang.org",
      "index.crates.io",
    ])
      expect(isNeverListed(host)).toBe(true);
  });

  it("leaves other hosts on shared platforms and look-alike names alone", () => {
    for (const host of [
      "api.github.com",
      "storage.googleapis.com",
      "s3.us-east-1.amazonaws.com",
      "notopenai.com",
      "openai.com.example.org",
      "api.stripe.com",
    ])
      expect(isNeverListed(host)).toBe(false);
  });
});

describe("host syntax", () => {
  it("accepts only exact lower-case DNS names", () => {
    expect(isValidSecretHost("api.github.com")).toBe(true);
    for (const host of [
      "API.github.com",
      "api.github.com.",
      "api.github.com:443",
      "*.github.com",
      "https://api.github.com",
      "api.github.com/path",
      "localhost",
      "10.0.0.1",
      "-bad.example.com",
      "",
    ])
      expect(isValidSecretHost(host)).toBe(false);
  });
});

describe("presets", () => {
  it("pass the host rules, so a preset always saves", () => {
    for (const preset of SECRET_PRESETS)
      expect(checkSecretHosts(preset.hosts).ok).toBe(true);
  });
});
