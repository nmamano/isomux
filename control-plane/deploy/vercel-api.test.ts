// What may be addressed, what may be set, and what may be printed when any of
// it fails.
//
// The canaries here are SHAPED like the real values and are published in this
// file, so a leak of one is an observation rather than an incident - the same
// move `deploy/secrets.ts` makes with PROBE_CANARY.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEPLOYMENT_ENV_NAMES,
  ENV_TOTAL_BYTES_LIMIT,
  FORBIDDEN_ENV_NAMES,
  FORBIDDEN_PROJECT_NAMES,
  PROJECT_NAME,
  anyValueAppears,
  inspectLink,
  projectNameUsable,
  validateEnvPairs,
  vercelApi,
} from "./vercel-api.ts";

/** Shaped like a DSN and like a bearer, and both are public. */
const CANARY_DSN = "postgresql://canary-role:canary-pw@canary-host/canary-db";
const CANARY_TOKEN = "isomux-d3-public-canary-0123456789abcdef";

const GOOD = [
  { name: "CONTROL_PLANE_DB", value: CANARY_DSN },
  { name: "AUTH_SECRET", value: "canary-secret" },
  { name: "AUTH_URL", value: "https://cloud.isomux.com" },
  {
    name: "CONTROL_PLANE_MINT_URL",
    value: "https://isomux-provisioner.fly.dev",
  },
  { name: "CONTROL_PLANE_MINT_TOKEN", value: CANARY_TOKEN },
];

describe("which project may be addressed", () => {
  test("the landing page is refused by name", () => {
    expect(FORBIDDEN_PROJECT_NAMES).toContain("isomux");
    expect(projectNameUsable("isomux")).toBe(false);
    expect(projectNameUsable(PROJECT_NAME)).toBe(true);
    // A near miss is not our project either: the check is equality, not a
    // prefix, and `isomux-control-plane-preview` would be a different site.
    expect(projectNameUsable("isomux-control-plane-old")).toBe(false);
  });

  test("THE ROOT LINK IS NEVER WHAT WE DEPLOY THROUGH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d3-link-"));
    fs.mkdirSync(path.join(dir, ".vercel"));
    const write = (body: unknown) =>
      fs.writeFileSync(
        path.join(dir, ".vercel", "project.json"),
        JSON.stringify(body),
      );

    const OURS = { projectId: "prj_ours", orgId: "acct_nil" };

    // The shape the repository root actually carries today.
    write({
      projectId: "prj_landing",
      orgId: "acct_nil",
      projectName: "isomux",
    });
    expect(inspectLink(dir, OURS, "prj_landing")).toEqual({
      present: true,
      matches: false,
      forbidden: true,
    });

    // The landing project RENAMED is still forbidden, by id.
    write({
      projectId: "prj_landing",
      orgId: "acct_nil",
      projectName: "something-else",
    });
    expect(inspectLink(dir, OURS, "prj_landing").forbidden).toBe(true);

    // Our project, by id, scope AND name.
    write({ ...OURS, projectName: PROJECT_NAME });
    expect(inspectLink(dir, OURS, "prj_landing")).toEqual({
      present: true,
      matches: true,
      forbidden: false,
    });

    // The right name with the wrong id is not a link we may act through: the
    // id is the thing the CLI acts on.
    write({
      projectId: "prj_someone_else",
      orgId: "acct_nil",
      projectName: PROJECT_NAME,
    });
    expect(inspectLink(dir, OURS, "prj_landing").matches).toBe(false);

    // THE RIGHT PROJECT IN THE WRONG SCOPE IS NOT OUR PROJECT.
    write({
      projectId: "prj_ours",
      orgId: "acct_someone_else",
      projectName: PROJECT_NAME,
    });
    expect(inspectLink(dir, OURS, "prj_landing").matches).toBe(false);

    // The right id with no name, or no scope, proves only part of it.
    write({ projectId: "prj_ours", orgId: "acct_nil" });
    expect(inspectLink(dir, OURS, "prj_landing").matches).toBe(false);
    write({ projectId: "prj_ours", projectName: PROJECT_NAME });
    expect(inspectLink(dir, OURS, "prj_landing").matches).toBe(false);

    fs.writeFileSync(path.join(dir, ".vercel", "project.json"), "{not json");
    expect(inspectLink(dir, OURS, "prj_landing")).toEqual({
      present: true,
      matches: false,
      forbidden: false,
    });

    fs.rmSync(dir, { recursive: true, force: true });
    expect(inspectLink(dir, OURS, "prj_landing").present).toBe(false);
  });
});

describe("what may be set on the deployment", () => {
  test("the real set validates", () => {
    expect(validateEnvPairs(GOOD)).toEqual([]);
  });

  test("EVERY forbidden name is refused, one at a time", () => {
    for (const name of FORBIDDEN_ENV_NAMES) {
      const problems = validateEnvPairs([{ name, value: "anything" }]);
      expect({ name, problems }).toEqual({
        name,
        problems: [`refused outright: ${name}`],
      });
    }
  });

  test("the allowlist and the refusal list cannot overlap", () => {
    const forbidden = new Set<string>(FORBIDDEN_ENV_NAMES);
    for (const name of DEPLOYMENT_ENV_NAMES) {
      expect({ name, forbidden: forbidden.has(name) }).toEqual({
        name,
        forbidden: false,
      });
    }
  });

  test("no Stripe value, no dev-auth flag, no provider credential is allowed", () => {
    // The posture stated in the plan gate, asserted rather than described: with
    // no price configured, signUpOffice refuses before it reserves a name.
    for (const name of [
      "STRIPE_TEST_SECRET_KEY",
      "CONTROL_PLANE_PRICE_ID",
      "CONTROL_PLANE_ENTRY_PRICE_ID",
      "CONTROL_PLANE_POWERUSER_PRICE_ID",
      "CONTROL_PLANE_COUPON_ID",
      "CONTROL_PLANE_DEV_AUTH",
      "NEXT_PUBLIC_CONTROL_PLANE_DEV_AUTH",
      "CONTABO_API_PASSWORD",
      "FLY_API_TOKEN",
    ]) {
      expect({
        name,
        allowed: (DEPLOYMENT_ENV_NAMES as readonly string[]).includes(name),
        forbidden: (FORBIDDEN_ENV_NAMES as readonly string[]).includes(name),
      }).toEqual({ name, allowed: false, forbidden: true });
    }
  });

  test("an unruled name is refused even when it looks harmless", () => {
    expect(
      validateEnvPairs([{ name: "NODE_ENV", value: "production" }]),
    ).toEqual(["not an allowed name: NODE_ENV"]);
  });

  test("a control character in a value is refused", () => {
    for (const [label, value] of [
      ["newline", "a\nb"],
      ["carriage return", "a\rb"],
      ["NUL", "a\u0000b"],
      ["delete", "a\u007fb"],
    ] as const) {
      const problems = validateEnvPairs([{ name: "AUTH_SECRET", value }]);
      expect({ label, problems }).toEqual({
        label,
        problems: ["value carries a control character: AUTH_SECRET"],
      });
    }
  });

  test("empty and duplicate are both refusals", () => {
    expect(validateEnvPairs([{ name: "AUTH_SECRET", value: "" }])).toEqual([
      "empty value: AUTH_SECRET",
    ]);
    expect(
      validateEnvPairs([
        { name: "AUTH_URL", value: "https://a.example" },
        { name: "AUTH_URL", value: "https://b.example" },
      ]),
    ).toEqual(["named twice: AUTH_URL"]);
  });

  test("the size ceiling refuses with a COUNT and never the contents", () => {
    const value = "x".repeat(ENV_TOTAL_BYTES_LIMIT + 1);
    const problems = validateEnvPairs([{ name: "AUTH_SECRET", value }]);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("bytes");
    expect(problems[0]).not.toContain(value);
  });

  test("no problem string ever quotes a value", () => {
    const problems = validateEnvPairs([
      { name: "STRIPE_TEST_SECRET_KEY", value: CANARY_TOKEN },
      { name: "NOPE", value: CANARY_DSN },
      { name: "AUTH_SECRET", value: "a\nb" },
    ]);
    expect(problems.length).toBe(3);
    const joined = problems.join("\n");
    for (const secret of [CANARY_TOKEN, CANARY_DSN, "a\nb"]) {
      expect(joined).not.toContain(secret);
    }
  });
});

describe("what a failed request may say", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("A VERCEL ERROR BODY NEVER REACHES THE MESSAGE", async () => {
    // Vercel quotes back what it was asked for. This body carries both canaries
    // and the project name, which is exactly what an error body does in life.
    const body = JSON.stringify({
      error: {
        message: `invalid value ${CANARY_DSN} for ${PROJECT_NAME}`,
        token: CANARY_TOKEN,
      },
    });
    // Through `unknown`: a stub that answers one request is not a `fetch` -
    // it has no `preconnect` - and tsc is right to say so.
    globalThis.fetch = (async () =>
      new Response(body, { status: 422 })) as unknown as typeof fetch;

    const failure = await vercelApi("/v9/projects", CANARY_TOKEN, {
      method: "POST",
      body: { name: PROJECT_NAME },
    }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(Error);
    const seen = `${(failure as Error).message}\n${(failure as Error).stack ?? ""}`;
    expect((failure as Error).message).toBe(
      "the Vercel API answered 422 to a POST",
    );
    for (const secret of [CANARY_DSN, CANARY_TOKEN]) {
      expect(anyValueAppears(seen, [secret])).toBe(false);
    }
    // And no cause: a cause is how the original comes back one layer down.
    expect((failure as Error).cause).toBeUndefined();
  });

  test("the scanner catches an exact value, which is why it is not the guarantee", () => {
    expect(
      anyValueAppears(`prefix ${CANARY_TOKEN} suffix`, [CANARY_TOKEN]),
    ).toBe(true);
    // A fragment is invisible to it. Stated as a test so nobody mistakes the
    // scan for the protection: not emitting the bytes is the protection.
    expect(anyValueAppears(CANARY_TOKEN.slice(0, 12), [CANARY_TOKEN])).toBe(
      false,
    );
    expect(anyValueAppears("nothing here", [""])).toBe(false);
  });
});
