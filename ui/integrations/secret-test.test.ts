import { describe, expect, it } from "bun:test";
import { secretTestKind } from "../../server/connection-tests.ts";
import { SECRET_PRESETS, type SecretForm } from "../../shared/secret-hosts.ts";
import { hasSecretTest } from "./secret-test.ts";

// The page decides alone whether a secret row gets a Test (another member's
// rows have no connections list behind them). It must agree with the server.
describe("hasSecretTest", () => {
  const forms: SecretForm[] = [
    { kind: "authorization" },
    { kind: "header", header: "x-api-key" },
  ];
  const hostSets = [
    ...SECRET_PRESETS.map((preset) => preset.hosts),
    ["api.github.com"],
    ["github.com"],
    ["uploads.github.com", "api.stripe.com"],
    ["api.machines.dev"],
    ["api.fly.io"],
    ["api.example.com"],
    [],
  ];
  for (const form of forms)
    for (const hosts of hostSets)
      it(`${form.kind} on [${hosts.join(", ")}] matches the server`, () => {
        expect(hasSecretTest({ form, hosts })).toBe(
          secretTestKind({ form, hosts }) !== null,
        );
      });
});
