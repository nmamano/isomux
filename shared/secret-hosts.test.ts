import { describe, expect, it } from "bun:test";

import {
  SECRET_PRESETS,
  checkSecretHosts,
  checkSecretName,
  isNeverListed,
  isPublicAddressValue,
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

// Task d28140c9: log masking and the proxy scrub skip a secret value that is
// a public address. Everything else stays masked, a short or dotted password
// above all.
describe("isPublicAddressValue", () => {
  it("is true for a whole domain, email, @domain handle or bare origin", () => {
    for (const value of [
      "example.com",
      "foo.bsky.social",
      "news.example.co.uk",
      "my-app.dev",
      "example.xn--p1ai",
      "contact@example.com",
      "First.Last+tag@mail.example.org",
      "@example.com",
      "@alice.bsky.social",
      "https://example.com",
      "https://example.com/",
      "http://example.com:8080",
      "https://api.example.com:443/",
    ])
      expect([value, isPublicAddressValue(value)]).toEqual([value, true]);
  });

  it("is false for a password, a credential in an address, or a local or IP host", () => {
    for (const value of [
      // Passwords, dotted ones too: the last label is no public suffix, or
      // the case is not a hostname's.
      "hunter2!",
      "my.password",
      "summer.vacation",
      "abc.def",
      "abc.def1",
      "Summer.Love",
      "Example.Com",
      // A bare handle cannot be told from a password that starts with @.
      "@Passw0rd",
      "@dm1n_2024",
      "@alice",
      // A URL with a path, query, fragment or user part can carry a token.
      "https://example.com/hooks/T0000/B0000/abcdefghijkl",
      "https://example.com/?token=abcdefgh",
      "https://example.com?token=abcdefgh",
      "https://example.com#access_token=abcdefgh",
      "https://user:pass@example.com",
      "https://token@example.com",
      "user:pass@example.com",
      "p@ss@example.com",
      "ftp://example.com",
      "example.com/path",
      "example.com:8080",
      // Not a public host.
      "localhost",
      "contact@localhost",
      "foo.localhost",
      "abc.onion",
      "1.0.0.127.in-addr.arpa",
      "10.0.0.1",
      "https://127.0.0.1",
      "example.com.",
      "-example.com",
      "",
    ])
      expect([value, isPublicAddressValue(value)]).toEqual([value, false]);
  });
});

describe("presets", () => {
  it("pass the host rules, so a preset always saves", () => {
    for (const preset of SECRET_PRESETS)
      expect(checkSecretHosts(preset.hosts).ok).toBe(true);
  });
});

describe("checkSecretName", () => {
  it("refuses every name the proxy sets in an agent's environment", () => {
    for (const name of [
      "HTTPS_PROXY",
      "https_proxy",
      "NO_PROXY",
      "no_proxy",
      "SSL_CERT_FILE",
      "NODE_EXTRA_CA_CERTS",
      "CODEX_CA_CERTIFICATE",
      "REQUESTS_CA_BUNDLE",
      "CURL_CA_BUNDLE",
      "GIT_SSL_CAINFO",
      "CARGO_HTTP_CAINFO",
      "NODE_USE_ENV_PROXY",
    ])
      expect(checkSecretName(name)).toEqual({
        field: "name",
        reason: "reserved",
      });
  });
});
