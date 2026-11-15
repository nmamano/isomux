// The secret env of an isolated member's agents (internal-docs/
// member-os-user-design.md, slice 2d-ii): the member cannot read the
// office's CA bundle, so each CA variable that the secret env sets names
// the copy in their share. The proxy address stays. An office env is as it
// was.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  buildEnvForUserId,
  setSecretEnvironmentProvider,
} from "../env-loader.ts";
import { memberSharePath } from "../member-runtime.ts";
import { CA_BUNDLE_VARIABLES } from "../secret-proxy/material.ts";
import { createMember } from "../users.ts";
import { isolateMember, type IsolatedMember } from "./member-host-fixture.ts";

const OFFICE_BUNDLE = "/office/share/secrets/ca-bundle.pem";
const PROXY = "http://isomux:fake-password@127.0.0.1:1";
// The seven names, written out: the list in material.ts is under test too.
const CA_NAMES = [
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "CODEX_CA_CERTIFICATE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "CARGO_HTTP_CAINFO",
];

let iso: IsolatedMember;
let office: string;
let restore: Parameters<typeof setSecretEnvironmentProvider>[0];

beforeEach(async () => {
  const member = createMember(`SecretEnv${Date.now()}`, { role: "member" });
  if (!member.ok) throw new Error(member.error);
  const other = createMember(`SecretEnvOffice${Date.now()}`, {
    role: "member",
  });
  if (!other.ok) throw new Error(other.error);
  office = other.user.id;
  iso = await isolateMember(member.user.id);
  restore = setSecretEnvironmentProvider(() => ({
    office: {},
    member: {},
    fixed: {
      HTTPS_PROXY: PROXY,
      ...Object.fromEntries(CA_NAMES.map((name) => [name, OFFICE_BUNDLE])),
    },
    gitCredentials: [],
    revision: "test",
  }));
});

afterEach(() => {
  setSecretEnvironmentProvider(restore);
  iso.dispose();
});

describe("the secret env of an isolated member's agents", () => {
  it("names the CA bundle in their share for each CA variable, and keeps the proxy", () => {
    expect([...CA_BUNDLE_VARIABLES] as string[]).toEqual(CA_NAMES);
    const env = buildEnvForUserId(iso.userId) ?? {};
    const copy = `${memberSharePath("isomux-test-member")}/secrets/ca-bundle.pem`;
    for (const name of CA_NAMES)
      expect([name, env[name]]).toEqual([name, copy]);
    expect(env.HTTPS_PROXY).toBe(PROXY);
  });

  it("leaves an office member's env as the secret env gives it", () => {
    const env = buildEnvForUserId(office) ?? {};
    for (const name of CA_NAMES)
      expect([name, env[name]]).toEqual([name, OFFICE_BUNDLE]);
    expect(env.HTTPS_PROXY).toBe(PROXY);
  });
});
