import { describe, expect, it } from "bun:test";

import {
  SECRET_EXCHANGE_PRESETS,
  SECRET_PRESETS,
  checkSecretExchange,
  checkSecretForm,
  checkSecretHosts,
  checkSecretName,
  isNeverListed,
  isValidSecretHost,
  type ExchangeSpec,
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

// The token exchange (task 124eb47e). The raw client or app secret goes to
// the token address, so that address is held to the host rules, and the
// reply paths cannot walk into the prototype.
describe("token exchange checks", () => {
  const HOSTS = ["api.example.com", "auth.example.com"];
  const SPEC: ExchangeSpec = {
    url: "https://auth.example.com/oauth/token",
    body: { kind: "oauth", clientAuth: "basic" },
    id: "client-1",
    params: { scope: "read" },
    tokenField: "access_token",
    expiryField: "expires_in",
  };
  const check = (patch: Record<string, unknown>, hosts = HOSTS) =>
    checkSecretExchange({ ...SPEC, ...patch }, hosts);
  const errorOf = (result: ReturnType<typeof checkSecretExchange>) =>
    result.ok ? null : result.error;

  it("accepts a full exchange and keeps its fields", () => {
    expect(checkSecretExchange(SPEC, HOSTS)).toEqual({
      ok: true,
      exchange: SPEC,
    });
    const json: ExchangeSpec = {
      ...SPEC,
      url: "https://auth.example.com:443/v3/token/internal?tenant=a",
      body: { kind: "json", idField: "app_id", secretField: "app_secret" },
      tokenField: "data.tenant_access_token",
      expiryField: "expire",
    };
    expect(checkSecretExchange(json, HOSTS).ok).toBe(true);
  });

  it("fills the defaults: access_token, expires_in, no params", () => {
    const { params, tokenField, expiryField, ...bare } = SPEC;
    void params;
    void tokenField;
    void expiryField;
    const result = checkSecretExchange(bare, HOSTS);
    expect(result.ok && result.exchange).toEqual({
      ...bare,
      params: {},
      tokenField: "access_token",
      expiryField: "expires_in",
    });
  });

  it("needs the token address's host among the secret's hosts", () => {
    // The raw secret goes to the token address: a host the member did not
    // list (and so did not vouch for) never gets it.
    expect(errorOf(check({}, ["api.example.com"]))).toEqual({
      field: "exchange",
      reason: "host",
    });
    expect(
      errorOf(check({ url: "https://evil.example.net/token" })),
    ).toMatchObject({ field: "exchange", reason: "host" });
    // An exchange needs a host: an app-only secret has no proxy use.
    expect(errorOf(check({}, []))?.field).toBe("exchange");
  });

  it("refuses a token address that is not plain https on 443", () => {
    for (const url of [
      "http://auth.example.com/token",
      "https://auth.example.com:8443/token",
      "https://user:pass@auth.example.com/token",
      "https://auth.example.com/token#frag",
      "https://127.0.0.1/token",
      "https://localhost/token",
      "auth.example.com/token",
      "",
      42,
    ])
      expect([
        url,
        errorOf(check({ url }, [...HOSTS, "localhost"]))?.field,
      ]).toEqual([url, "exchange"]);
  });

  it("refuses a never-listed token address even when the hosts list it", () => {
    // A hand-made hosts list that names a model API: the hosts check refuses
    // it on its own; the exchange check must not pass it either.
    expect(
      check({ url: "https://api.openai.com/v1/token" }, [
        ...HOSTS,
        "api.openai.com",
      ]).ok,
    ).toBe(false);
  });

  it("refuses a body shape it does not know, and a json body without both fields", () => {
    for (const body of [
      { kind: "oauth", clientAuth: "jwt" },
      { kind: "oauth" },
      { kind: "json", idField: "app_id" },
      { kind: "json", idField: "", secretField: "app_secret" },
      { kind: "json", idField: "same", secretField: "same" },
      { kind: "form" },
      null,
    ])
      expect([body, errorOf(check({ body }))?.field]).toEqual([
        body,
        "exchange",
      ]);
  });

  it("refuses an empty id and params that would overwrite the id, the secret or the grant", () => {
    expect(errorOf(check({ id: "" }))?.field).toBe("exchange");
    for (const params of [
      { grant_type: "password" },
      { client_secret: "x" },
      { client_id: "x" },
      { scope: 1 },
      Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`p${i}`, "v"])),
    ])
      expect([params, errorOf(check({ params }))?.field]).toEqual([
        params,
        "exchange",
      ]);
    const json = {
      body: { kind: "json", idField: "app_id", secretField: "app_secret" },
    };
    for (const params of [{ app_id: "x" }, { app_secret: "x" }])
      expect([params, errorOf(check({ ...json, params }))?.field]).toEqual([
        params,
        "exchange",
      ]);
    // Ten are allowed.
    expect(
      check({
        params: Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [`p${i}`, "v"]),
        ),
      }).ok,
    ).toBe(true);
  });

  it("refuses a reply path that walks into the prototype or has an empty step", () => {
    for (const field of ["tokenField", "expiryField"])
      for (const path of [
        "__proto__",
        "data.__proto__.token",
        "constructor",
        "constructor.prototype",
        "a..b",
        ".token",
        "",
      ])
        expect([field, path, errorOf(check({ [field]: path }))?.field]).toEqual(
          [field, path, "exchange"],
        );
  });
});

describe("the query form", () => {
  it("is a form only for a secret with a token exchange", () => {
    const form = { kind: "query" as const, param: "access_token" };
    expect(checkSecretForm(form, { exchange: true })).toEqual({
      ok: true,
      form,
    });
    expect(checkSecretForm(form).ok).toBe(false);
    expect(checkSecretForm(form, { exchange: false }).ok).toBe(false);
  });

  it("keeps the parameter name's case and takes only unreserved characters", () => {
    for (const param of ["Access_Token", "a", "x.y~z-1", "p".repeat(64)])
      expect(
        checkSecretForm({ kind: "query", param }, { exchange: true }),
      ).toEqual({
        ok: true,
        form: { kind: "query", param },
      });
    for (const param of [
      "",
      "p".repeat(65),
      "a b",
      "a=b",
      "a&b",
      "a%5F",
      "a+b",
      "ä",
      7,
    ])
      expect([
        param,
        checkSecretForm({ kind: "query", param }, { exchange: true }).ok,
      ]).toEqual([param, false]);
  });
});

describe("token exchange presets", () => {
  const byHost = (host: string) =>
    SECRET_EXCHANGE_PRESETS.find((preset) => preset.hosts.includes(host));

  it("Feishu and Lark save with an app id, and send the app id and secret as JSON", () => {
    for (const host of ["open.feishu.cn", "open.larksuite.com"]) {
      const preset = byHost(host);
      expect(preset).toBeDefined();
      const result = checkSecretExchange(
        { ...preset!.exchange, id: "cli_fake0001" },
        preset!.hosts,
      );
      expect([host, result.ok]).toEqual([host, true]);
      expect(preset!.exchange).toMatchObject({
        url: `https://${host}/open-apis/auth/v3/tenant_access_token/internal`,
        body: { kind: "json", idField: "app_id", secretField: "app_secret" },
        tokenField: "tenant_access_token",
        expiryField: "expire",
      });
      expect(preset!.form).toEqual({ kind: "authorization" });
      expect(checkSecretHosts(preset!.hosts).ok).toBe(true);
    }
  });

  it("an OAuth client credentials preset leaves the address and hosts to the member", () => {
    const oauth = SECRET_EXCHANGE_PRESETS.find(
      (preset) => preset.exchange.body.kind === "oauth",
    );
    expect(oauth).toBeDefined();
    expect(oauth!.hosts).toEqual([]);
    expect(oauth!.exchange.url).toBe("");
    expect(oauth!.form).toEqual({ kind: "authorization" });
  });
});
