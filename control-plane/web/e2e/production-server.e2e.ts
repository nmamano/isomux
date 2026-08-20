#!/usr/bin/env bun
// The production web server, driven in a real browser against a real Postgres.
//
// This is the transcript the whole Postgres port was for. The wall it answers,
// measured 2026-08-10 BEFORE the port: there was no production server at all -
// `next start` under Node died loading `bun:sqlite`, and `bun --bun next start`
// died in Next's own compiled runtime. With a driver that loads under both, the
// question stops being "does it boot" and becomes "does a store-backed page
// actually come back", which is what every check below is about.
//
// It measures ONE CELL of the runtime matrix per run, named by its flags, so
// the table in `control-plane/README.md` is a record of runs of this file
// rather than of somebody's recollection:
//
//   bun e2e/production-server.e2e.ts --runtime node --mode start
//   bun e2e/production-server.e2e.ts --runtime bun  --mode start
//   bun e2e/production-server.e2e.ts --runtime node --mode dev
//   bun e2e/production-server.e2e.ts --runtime bun  --mode dev
//
// `--skip-build 1` serves whatever `.next` is already there, which is how the
// one interesting off-diagonal cell gets measured: a bun `next start` over a
// build Node produced. Without it the runtime that builds is the runtime that
// serves, which is the honest default - a deployment does not get to mix them
// by accident.
//
// The exit code means SERVES: zero only if every check below passed, so a cell
// that boots and then cannot answer is a failure here rather than a footnote.
//
// WHAT IS REAL: the database (a scratch one in the local container), the rows
// (written through the same `accountForDevSignIn` + `reserveOffice` path signup
// uses), the server (built and started by this file, under the runtime named on
// the command line), the pages, the API route, the operator grant, and Chrome.
//
// WHAT IS NOT DRIVEN, and deliberately: the sign-in CEREMONY. Measured
// 2026-08-10, `/api/auth/providers` under `next start` returns `{}` - the dev
// credentials provider is gated on `CONTROL_PLANE_DEV_AUTH=1` AND
// `NODE_ENV !== "production"`, a production build settles the second half at
// build time, and `/signin` is prerendered, so no runtime setting brings it
// back. Google is the production ceremony and no OAuth client exists yet. So
// this file mints a REAL Auth.js session cookie - the deployment's own secret,
// the same encryption Auth.js does, no product code relaxed - and proves the
// thing that was actually in doubt: that an authenticated request reaches
// store-backed pages under a production server. Weakening the auth gate to make
// a transcript convenient would trade the property for the proof of it.
//
// The session is nailed to a durable account rather than assumed: a SECOND
// account's cookie asks for the SAME office and must be refused, so a 200 here
// means "this account's own row" and not "any signed-in caller".

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { encode } from "next-auth/jwt";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { setOperator } from "../../operator-admin.ts";
import {
  accountForDevSignIn,
  hostnameFor,
  reserveOffice,
} from "../../signup.ts";
import { Store } from "../../store.ts";
import { databaseUrl } from "../../config.ts";
import { LOCAL_DATABASE_URL } from "../../testing/pg.ts";
import { assertScratchTarget } from "../../testing/target.ts";

const WEB_DIR = path.join(import.meta.dir, "..");
const CHROME = "/usr/bin/google-chrome";
const PORT = Number(process.env.E2E_PORT ?? 3320);
const BASE = `http://localhost:${PORT}`;
/**
 * The session secret, MINTED PER RUN and never written down.
 *
 * Not a constant in this file: a checked-in value is a committed credential
 * whatever it was meant for, and the next reader is entitled to assume a string
 * shaped like a secret is one. 32 random bytes, used to sign the cookie and
 * handed to the server this file starts, both of which live and die with the
 * run. Nothing outside the process ever sees it.
 */
const SECRET = randomBytes(32).toString("base64url");
/** Auth.js derives its encryption key from the secret AND the cookie name. */
const COOKIE = "authjs.session-token";

const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  flags.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "");
}
const RUNTIME = flags.get("runtime") ?? "node";
const MODE = flags.get("mode") ?? "start";
const SKIP_BUILD = flags.get("skip-build") === "1";
if (RUNTIME !== "node" && RUNTIME !== "bun") {
  throw new Error("--runtime is node or bun");
}
if (MODE !== "start" && MODE !== "dev")
  throw new Error("--mode is start or dev");

/** The binary each runtime MUST turn out to be. Checked against the process
 * that owns the listening socket, not against what we asked for. */
const EXPECTED_BINARY: Record<string, string> = {
  node: process.env.E2E_NODE ?? "/usr/bin/node",
  bun: process.execPath,
};

const transcript: string[] = [];
function say(line: string): void {
  // A session cookie is a credential; so is the secret above. The rule is
  // narrow on purpose: a bare length threshold also eats the instance and
  // account ids, which are the instance-SPECIFIC evidence this transcript
  // exists to show. A JWE is dotted segments and nothing here is.
  const safe = line
    .replace(new RegExp(SECRET, "g"), "<secret redacted>")
    .replace(
      /\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_.-]{12,}/g,
      "<credential redacted>",
    );
  transcript.push(safe);
  console.log(safe);
}

function check(label: string, ok: boolean, detail = ""): void {
  say(`${ok ? "OK  " : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

function argvFor(step: "build" | "serve"): string[] {
  const next = "node_modules/.bin/next";
  const command = step === "build" ? ["build"] : [MODE, "-p", String(PORT)];
  return RUNTIME === "bun"
    ? ["bun", "--bun", next, ...command]
    : ["node", next, ...command];
}

async function waitForServer(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(BASE, { redirect: "manual" });
      if (res.status > 0) return true;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * The process holding the listening socket, and what binary it is.
 *
 * Not the pid we spawned: `next` may re-exec or hand the socket to a worker,
 * and the claim under test is about whoever ANSWERS. `/proc/<pid>/exe` is the
 * kernel's own answer to "what is this process running", which a command line
 * can lie about and an environment variable cannot settle.
 */
function listener(): { pid: number; exe: string } | null {
  const out = Bun.spawnSync(["ss", "-ltnpH", `sport = :${PORT}`]);
  const text = new TextDecoder().decode(out.stdout);
  const match = text.match(/pid=(\d+)/);
  if (!match) return null;
  const pid = Number(match[1]);
  try {
    return { pid, exe: fs.readlinkSync(`/proc/${pid}/exe`) };
  } catch {
    return { pid, exe: "<unreadable>" };
  }
}

async function versions(): Promise<void> {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(WEB_DIR, "package.json"), "utf8"),
  );
  const node = new TextDecoder()
    .decode(Bun.spawnSync(["node", "--version"]).stdout)
    .trim();
  say(
    `cell: --runtime ${RUNTIME} --mode ${MODE}` +
      (SKIP_BUILD ? " (over the existing build)" : ""),
  );
  say(`next ${pkg.dependencies.next}, bun ${Bun.version}, node ${node}`);
  say(`measured ${new Date().toISOString().slice(0, 10)}`);
}

async function main(): Promise<void> {
  await versions();

  const db = databaseUrl();
  // This transcript SEEDS ROWS - two accounts, a reservation, an instance - so
  // it is subject to the same refusal the suite is: a remote target must prove
  // it is the scratch branch before anything is written. Fail closed; there is
  // no flag that skips it.
  await assertScratchTarget(db, LOCAL_DATABASE_URL);
  say("target proved to be the scratch branch: true");
  const store = await Store.open(db);
  say(`database: ${store.describe()}`);

  // WHAT THE SERVER CONNECTS AS, which since D3.5 need not be what this file
  // connects as. The deployed web tier holds a role that is granted rows and
  // not the schema, so it opens a RUNTIME store and cannot run a schema
  // statement at all - which means the harness cannot seed through the same
  // credential the app serves under. That split is the deployment's shape, so
  // the transcript reproduces it rather than papering over it: this file seeds
  // as the operator, and the server is handed whatever `CONTROL_PLANE_DB_APP`
  // names. Unset, both are the same DSN and the run is exactly what it was.
  const appDb = process.env.CONTROL_PLANE_DB_APP ?? db;
  say(`server runs as a separate least-privileged role: ${appDb !== db}`);

  // The rows a signed-up customer would have, written by the product's own
  // signup path rather than by hand.
  const stamp = Date.now().toString(36);
  const owner = await accountForDevSignIn(
    store,
    `p3-owner-${stamp}@example.com`,
  );
  const stranger = await accountForDevSignIn(
    store,
    `p3-stranger-${stamp}@example.com`,
  );
  const officeName = `p3prod${stamp}`;
  const reserved = await reserveOffice(store, {
    accountId: owner.id,
    officeName,
    plan: "office",
    couponId: null,
  });
  if (!reserved.ok) throw new Error(`could not seed: ${reserved.reason}`);
  const instanceId = reserved.reservation.instance_id;
  // What the page must show: the office name is what the customer typed, and
  // the hostname is what signup derived from it.
  const hostname = hostnameFor(officeName);
  say(`seeded office ${hostname} (${instanceId}) for ${owner.id}`);

  const cookieFor = async (accountId: string, email: string): Promise<string> =>
    encode({
      token: { accountId, email, sub: accountId },
      secret: SECRET,
      salt: COOKIE,
      maxAge: 3600,
    });
  const ownerCookie = await cookieFor(owner.id, owner.email);
  const strangerCookie = await cookieFor(stranger.id, stranger.email);

  if (MODE === "start" && !SKIP_BUILD) {
    const build = argvFor("build");
    say(`build: ${build.join(" ")}`);
    const proc = Bun.spawnSync(build, {
      cwd: WEB_DIR,
      env: { ...process.env, CONTROL_PLANE_DB: appDb },
    });
    // On a failure the useful line is the FIRST error, not the last four lines
    // of stack: a tail alone reported "at processTicksAndRejections" for a
    // failure whose actual message names the module that could not be loaded.
    const output = new TextDecoder()
      .decode(proc.exitCode === 0 ? proc.stdout : proc.stderr)
      .trim()
      .split("\n");
    const detail =
      proc.exitCode === 0
        ? output.slice(-1).join("")
        : (output.find((l) => /error/i.test(l)) ?? output.slice(-1).join(""));
    check(`${RUNTIME} next build`, proc.exitCode === 0, detail.trim());
    if (proc.exitCode !== 0) {
      await store.close();
      return;
    }
  }

  // A port somebody else is holding is not a cell this file may measure. It is
  // not a hypothetical: an earlier run's server survived its own teardown once,
  // `next dev` quietly moved to the next free port, and every check afterwards
  // interrogated the WRONG process - which the listener check below caught and
  // nothing else would have.
  const squatter = listener();
  check(
    `port ${PORT} is free before the run`,
    squatter === null,
    squatter ? `pid ${squatter.pid} (${squatter.exe}) holds it` : "",
  );
  if (squatter) {
    await store.close();
    return;
  }

  const serve = argvFor("serve");
  say(`serve: ${serve.join(" ")}`);
  // Named, never shown: the transcript is an artifact somebody reads.
  say("AUTH_SECRET: set (throwaway, generated for this run)");
  const log = fs.openSync(`/tmp/p3-${RUNTIME}-${MODE}.log`, "w");
  const server = Bun.spawn(serve, {
    cwd: WEB_DIR,
    env: {
      ...process.env,
      CONTROL_PLANE_DB: appDb,
      AUTH_SECRET: SECRET,
      AUTH_URL: BASE,
      // Set on purpose, to show it does NOT bring the dev provider back in a
      // production build. In dev it does, and this file still does not use it.
      CONTROL_PLANE_DEV_AUTH: "1",
    },
    stdout: log,
    stderr: log,
  });

  let browser: Browser | null = null;
  try {
    const up = await waitForServer(MODE === "dev" ? 180_000 : 90_000);
    check(
      "the server answers",
      up,
      up ? "" : `see /tmp/p3-${RUNTIME}-${MODE}.log`,
    );
    if (!up) return;

    const owning = listener();
    check("a process owns the listening socket", owning !== null);
    if (owning) {
      say(
        `listener pid ${owning.pid}, /proc/${owning.pid}/exe -> ${owning.exe}`,
      );
      check(
        `the serving process is ${RUNTIME}`,
        owning.exe === EXPECTED_BINARY[RUNTIME],
        `expected ${EXPECTED_BINARY[RUNTIME]}`,
      );
    }

    // Read as TEXT, not JSON. A runtime that boots and then fails inside a
    // route handler answers this with an error page, and a driver that assumed
    // JSON would report a parse error where the measurement is "the route did
    // not answer".
    const providersRes = await fetch(`${BASE}/api/auth/providers`);
    // Kept WHOLE for the assertion below and truncated only for the line the
    // reader sees: parsing a body cut at 200 characters would throw on the
    // development answer, which is the longer of the two.
    const providersBody = await providersRes.text();
    say(
      `sign-in providers: ${providersRes.status} ${providersBody
        .slice(0, 200)
        .replace(/\s+/g, " ")}`,
    );
    // Status and content type FIRST, and the body is parsed only if both hold:
    // a runtime that fails inside the route answers 500 with an error page, and
    // that has to stay a clear transcript failure rather than becoming a parse
    // error somewhere further down.
    const answersJson =
      providersRes.status === 200 &&
      providersRes.headers.get("content-type")?.includes("json") === true;
    check(
      "the auth route answers 200 and JSON",
      answersJson,
      `${providersRes.status} ${providersRes.headers.get("content-type") ?? "no content type"}`,
    );
    // The obstacle, asserted rather than narrated. Under a PRODUCTION build the
    // dev credentials provider must be absent - its gate names
    // `NODE_ENV !== "production"`, which the build settles - and Google is
    // unconfigured, so the list is empty. Under `next dev` the same gate lets it
    // through. Either answer failing means the gate moved, and this file would
    // otherwise be the last place to notice, since it is the one that works
    // around it.
    if (answersJson) {
      const configured = Object.keys(
        JSON.parse(providersBody) as Record<string, unknown>,
      );
      check(
        MODE === "start"
          ? "no sign-in provider exists in a production build"
          : "the dev provider is the only one in a development build",
        MODE === "start"
          ? configured.length === 0
          : configured.length === 1 && configured[0] === "dev",
        configured.join(",") || "none",
      );
    }

    browser = await chromium.launch({ executablePath: CHROME, headless: true });

    const contextFor = async (cookie: string): Promise<BrowserContext> => {
      const context = await browser!.newContext();
      await context.addCookies([
        { name: COOKIE, value: cookie, domain: "localhost", path: "/" },
      ]);
      return context;
    };

    // Signed out: the office is not a public page.
    const anonymous = await browser.newContext();
    const anon = await anonymous.newPage();
    await anon.goto(`${BASE}/office/${officeName}`, {
      waitUntil: "domcontentloaded",
    });
    check(
      "signed out, the office redirects to sign-in",
      new URL(anon.url()).pathname === "/signin",
      anon.url(),
    );
    await anon.goto(`${BASE}/office/${instanceId}`, {
      waitUntil: "domcontentloaded",
    });
    check(
      "signed out, an internal-id route redirects to sign-in",
      new URL(anon.url()).pathname === "/signin",
      anon.url(),
    );
    await anonymous.close();

    // The owner's own office, rendered from the rows seeded above.
    const ownerContext = await contextFor(ownerCookie);
    const page = await ownerContext.newPage();
    const response = await page.goto(`${BASE}/office/${officeName}`, {
      waitUntil: "domcontentloaded",
    });
    check(
      "the office answers 200",
      response?.status() === 200,
      String(response?.status()),
    );
    check(
      "the office name is the canonical route",
      new URL(page.url()).pathname === `/office/${officeName}`,
      page.url(),
    );
    const absent = await page.goto(`${BASE}/office/no-such-office`, {
      waitUntil: "domcontentloaded",
    });
    check(
      "an unknown office name keeps the not-found response",
      absent?.status() === 404,
      String(absent?.status()),
    );
    await page.goto(`${BASE}/office/${officeName}`, {
      waitUntil: "domcontentloaded",
    });
    const shown =
      (await page.textContent("[data-testid=office-hostname]")) ?? "";
    // The instance-specific value, not the presence of the element: a hard-coded
    // page would satisfy the second and cannot satisfy the first.
    check(
      "the page shows THIS office's hostname",
      shown.trim() === hostname,
      `${shown.trim()} vs ${hostname}`,
    );
    const status =
      (await page.textContent("[data-testid=office-status]")) ?? "";
    check(
      "the page reports the projection's own status",
      status.includes("not ready yet"),
      status.trim(),
    );
    const steps = await page.$$eval("[data-testid^=step-]", (nodes) =>
      nodes.map((n) => n.getAttribute("data-testid")),
    );
    check(
      "the ladder is derived from the instance's goal",
      steps.includes("step-create_instance") &&
        !steps.includes("step-revoke_access"),
      steps.join(","),
    );

    // The polled route, same identity, same database.
    const api = await page.evaluate(async (url: string) => {
      const res = await fetch(url);
      return { status: res.status, body: res.ok ? await res.json() : null };
    }, `${BASE}/api/progress/${instanceId}`);
    check(
      "the progress route answers for the owner",
      api.status === 200 && api.body?.hostname === hostname,
      `${api.status} ${api.body?.hostname ?? ""}`,
    );

    // The session is bound to a durable ACCOUNT, and the page is that account's.
    const strangerContext = await contextFor(strangerCookie);
    const strangerPage = await strangerContext.newPage();
    const refused = await strangerPage.goto(`${BASE}/office/${officeName}`, {
      waitUntil: "domcontentloaded",
    });
    check(
      "another signed-in account is refused the same office",
      refused?.status() === 404,
      String(refused?.status()),
    );
    const refusedInternalId = await strangerPage.goto(
      `${BASE}/office/${instanceId}`,
      { waitUntil: "domcontentloaded" },
    );
    check(
      "another account cannot use the instance id as an existence oracle",
      refusedInternalId?.status() === 404 &&
        new URL(strangerPage.url()).pathname === `/office/${instanceId}`,
      `${refusedInternalId?.status()} ${strangerPage.url()}`,
    );
    const internalId = await page.goto(`${BASE}/office/${instanceId}`, {
      waitUntil: "domcontentloaded",
    });
    check(
      "the owner's internal instance id is not a customer-facing route",
      internalId?.status() === 404 &&
        new URL(page.url()).pathname === `/office/${instanceId}`,
      `${internalId?.status()} ${page.url()}`,
    );

    // The operator floor, before and after the only writer of the flag.
    const beforeGrant = await page.goto(`${BASE}/ops`, {
      waitUntil: "domcontentloaded",
    });
    check(
      "the ops floor is 404 for a non-operator",
      beforeGrant?.status() === 404,
      String(beforeGrant?.status()),
    );
    const granted = await setOperator(store, {
      email: owner.email,
      on: true,
      actor: "p3-transcript",
    });
    check("the CLI's writer granted the flag", granted.ok);
    const afterGrant = await page.goto(`${BASE}/ops`, {
      waitUntil: "domcontentloaded",
    });
    check(
      "the same session reaches the floor once the flag is set",
      afterGrant?.status() === 200,
      String(afterGrant?.status()),
    );
    check(
      "the floor rendered its own empty state",
      (await page.$("[data-testid=ops-attention-empty]")) !== null,
    );

    await strangerContext.close();
    await ownerContext.close();
  } finally {
    if (browser) await browser.close();
    server.kill();
    await server.exited;
    // Killing the child we spawned is not the same as freeing the port: `next`
    // re-execs, and the process that ends up holding the socket can outlive the
    // one we started. The next cell's measurement depends on this one letting
    // go, so it is chased down by the pid that actually holds it.
    for (let i = 0; i < 40; i++) {
      const held = listener();
      if (!held) break;
      try {
        process.kill(held.pid, i < 20 ? "SIGTERM" : "SIGKILL");
      } catch {
        // already gone between the read and the signal
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    check(`port ${PORT} was released`, listener() === null);
    fs.closeSync(log);
    await store.close();
  }
}

try {
  await main();
} catch (err) {
  // A cell that throws is a cell that does not serve, and the transcript is
  // where that belongs - not in a stack trace with no RESULT line under it.
  check(
    "the run completed",
    false,
    err instanceof Error ? err.message : String(err),
  );
}
say(
  process.exitCode
    ? `RESULT: --runtime ${RUNTIME} --mode ${MODE} does NOT serve store-backed pages`
    : `RESULT: --runtime ${RUNTIME} --mode ${MODE} serves store-backed pages`,
);
