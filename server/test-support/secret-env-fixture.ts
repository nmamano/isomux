// An agent environment with secrets in scope, built by the real
// buildEnvForUserId from a fixed secrets environment. The backend spawn
// tests check that each engine's process gets it as it is.

import {
  buildEnvForUserId,
  setSecretEnvironmentProvider,
} from "../env-loader.ts";
import type { SecretEnvironment } from "../secret-proxy/runtime.ts";

// An obvious fake. It appears nowhere in the environment: the test asserts
// that no spawn path adds it.
export const SECRET_VALUE = "ghp_FAKEspawnFAKEspawnFAKEspawnFAKEsp01";
export const PLACEHOLDERS = {
  GH_TOKEN: "ghp_PLACEHOLDERspawnPLACEHOLDERspawn001",
  OFFICE_KEY: "officeplaceholder0000000000000000000001",
};
// A port nothing listens on: a stray connection fails at once.
const PROXY = "http://127.0.0.1:9";
const BUNDLE = "/nonexistent/isomux-test/ca-bundle.pem";
export const FIXED: Record<string, string> = {
  HTTPS_PROXY: PROXY,
  https_proxy: PROXY,
  NO_PROXY: "localhost,127.0.0.1,::1",
  no_proxy: "localhost,127.0.0.1,::1",
  SSL_CERT_FILE: BUNDLE,
  NODE_EXTRA_CA_CERTS: BUNDLE,
  CODEX_CA_CERTIFICATE: BUNDLE,
  REQUESTS_CA_BUNDLE: BUNDLE,
  CURL_CA_BUNDLE: BUNDLE,
  GIT_SSL_CAINFO: BUNDLE,
  CARGO_HTTP_CAINFO: BUNDLE,
  NODE_USE_ENV_PROXY: "1",
};

// The env of an agent of member "u-spawn", and what it must hold.
export function secretAgentEnvironment(): Record<string, string | undefined> {
  const environment: SecretEnvironment = {
    office: { OFFICE_KEY: PLACEHOLDERS.OFFICE_KEY },
    member: { GH_TOKEN: PLACEHOLDERS.GH_TOKEN },
    fixed: FIXED,
    gitCredentials: [],
    revision: "spawn-test",
  };
  const previous = setSecretEnvironmentProvider(() => environment);
  try {
    const env = buildEnvForUserId("u-spawn");
    if (!env) throw new Error("no environment");
    return env;
  } finally {
    setSecretEnvironmentProvider(previous);
  }
}

// The names and values a spawned process must have.
export const EXPECTED: Record<string, string> = { ...PLACEHOLDERS, ...FIXED };
