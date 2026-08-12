// What the acceptance probe accepts, and the two things it used to accept by
// mistake: a machine that answered 200 while reporting itself broken, and a
// surface that sent back a field nobody designed.

import { afterAll, describe, expect, test } from "bun:test";
import {
  GATING_KEYS,
  HEALTH_KEYS,
  PROVISIONER_ORIGIN,
  judgeHealth,
} from "./probe.ts";
import {
  CONTABO_SECRET_NAMES,
  contaboFileUsable,
  inspectContaboFile,
  inspectMintFile,
  parseContabo,
} from "./fly-cli.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HEALTHY = {
  ok: true,
  bounds_governed: true,
  branch_pinned: true,
  database_reachable: true,
  tick_recent: true,
  state_persisted: false,
  provider_configured: false,
};

describe("where the credential may be sent", () => {
  test("one fixed https origin, and no way to point it elsewhere", () => {
    expect(PROVISIONER_ORIGIN).toBe("https://isomux-provisioner.fly.dev");
    expect(new URL(PROVISIONER_ORIGIN).protocol).toBe("https:");
    // No path, no query: the request URLs are this plus the seam's own
    // constants, so no part of them comes from outside this repository.
    expect(new URL(PROVISIONER_ORIGIN).pathname).toBe("/");
    // The probe sends the real bearer, so an origin from argv would be a way to
    // hand it to whatever host somebody typed - with every check still passing.
    const source = fs.readFileSync(
      path.join(import.meta.dir, "probe.ts"),
      "utf8",
    );
    expect(source).not.toContain("process.argv");
  });
});

describe("the health verdict", () => {
  test("a first deploy is accepted with state_persisted false", () => {
    const verdict = judgeHealth(HEALTHY);
    expect(verdict.shapeOk).toBe(true);
    expect(verdict.gatingTrue).toBe(true);
    expect(GATING_KEYS).not.toContain("state_persisted" as never);
  });

  test("A PROVISIONER WITH NO PROVIDER CREDENTIALS IS NOT A FAILED ONE", () => {
    // It idles by design (measured over 37 minutes, 2026-08-11), so the reading
    // is reported and not gated. An operator asserts it at the gate that puts
    // the credentials there; `ok` never carries it.
    expect(GATING_KEYS).not.toContain("provider_configured" as never);
    expect(HEALTH_KEYS).toContain("provider_configured");
    const withCredentials = judgeHealth({
      ...HEALTHY,
      provider_configured: true,
    });
    expect(withCredentials.shapeOk).toBe(true);
    expect(withCredentials.gatingTrue).toBe(true);
    expect(judgeHealth(HEALTHY).gatingTrue).toBe(true);
  });

  test("the reading is still REPORTED, in both states", () => {
    expect(judgeHealth(HEALTHY).lines.join("\n")).toContain(
      "provider_configured: false",
    );
    expect(
      judgeHealth({ ...HEALTHY, provider_configured: true }).lines.join("\n"),
    ).toContain("provider_configured: true");
  });

  test("A DEGRADED MACHINE IS NOT ACCEPTED", () => {
    for (const key of GATING_KEYS) {
      const verdict = judgeHealth({ ...HEALTHY, [key]: false });
      expect({ key, gating: verdict.gatingTrue }).toEqual({
        key,
        gating: false,
      });
    }
  });

  test("a missing key is not a pass", () => {
    const { ok: _dropped, ...withoutOk } = HEALTHY;
    const verdict = judgeHealth(withoutOk);
    expect(verdict.shapeOk).toBe(false);
    expect(verdict.missingFields).toBe(1);
    expect(verdict.gatingTrue).toBe(false);
  });

  test("a key we did not design is counted, never named", () => {
    const verdict = judgeHealth({ ...HEALTHY, invite_url: "https://secret" });
    expect(verdict.shapeOk).toBe(false);
    expect(verdict.unexpectedFields).toBe(1);
    // The whole point: nothing the surface sent reaches the transcript.
    expect(verdict.lines.join("\n")).not.toContain("invite_url");
    expect(verdict.lines.join("\n")).not.toContain("secret");
  });

  test("a non-boolean value is refused rather than printed", () => {
    const verdict = judgeHealth({ ...HEALTHY, tick_recent: "yes-ish" });
    expect(verdict.shapeOk).toBe(false);
    expect(verdict.nonBooleanFields).toBe(1);
    expect(verdict.gatingTrue).toBe(false);
    expect(verdict.lines.join("\n")).toContain("tick_recent: NOT A BOOLEAN");
    expect(verdict.lines.join("\n")).not.toContain("yes-ish");
  });

  test("a body that is not an object at all is refused", () => {
    for (const body of [null, "ok", 42, undefined]) {
      expect(judgeHealth(body).shapeOk).toBe(false);
      expect(judgeHealth(body).gatingTrue).toBe(false);
    }
  });

  test("the keys are printed in a fixed order", () => {
    const verdict = judgeHealth(HEALTHY);
    expect(verdict.lines.map((l) => l.trim().split(":")[0])).toEqual([
      ...HEALTH_KEYS,
    ]);
  });
});

describe("the credential file the probe and the import share", () => {
  const temps: string[] = [];
  const write = (name: string, contents: string, mode: number): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-mint-"));
    temps.push(dir);
    const file = path.join(dir, name);
    fs.writeFileSync(file, contents, { mode });
    fs.chmodSync(file, mode);
    return file;
  };
  const GOOD = `CONTROL_PLANE_MINT_TOKEN='${"a1b2c3d4".repeat(5)}'\n`;

  test("the ruled shape passes and yields the token", () => {
    const { checks, token } = inspectMintFile(write("m.env", GOOD, 0o600));
    expect(checks).toEqual({
      present: true,
      regularFile: true,
      mode600: true,
      shapeOk: true,
    });
    expect(token).toBe("a1b2c3d4".repeat(5));
  });

  test("a readable-by-others file fails and yields NO token", () => {
    const { checks, token } = inspectMintFile(write("m.env", GOOD, 0o644));
    expect(checks.mode600).toBe(false);
    expect(token).toBe("");
  });

  test("0400 fails too - the mode is compared, not sampled", () => {
    // A bitmask test for "no group or world bits" would have passed this.
    expect(inspectMintFile(write("m.env", GOOD, 0o400)).checks.mode600).toBe(
      false,
    );
  });

  test("a symlink is refused rather than followed", () => {
    // O_NOFOLLOW: the open itself fails, so there is no window between deciding
    // the path is a file and reading it. The swap a plain lstat would have left
    // open cannot be reached, because after the open there is no path in play.
    const real = write("m.env", GOOD, 0o600);
    const link = path.join(path.dirname(real), "link.env");
    fs.symlinkSync(real, link);
    const { checks, token } = inspectMintFile(link);
    expect(checks.regularFile).toBe(false);
    expect(checks.present).toBe(true);
    expect(token).toBe("");
  });

  test("a directory in the credential's place is refused", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-mint-dir-"));
    temps.push(dir);
    const { checks, token } = inspectMintFile(dir);
    expect(checks.regularFile).toBe(false);
    expect(token).toBe("");
  });

  test("a file with no trailing newline at all is still the ruled shape", () => {
    const { checks, token } = inspectMintFile(
      write("m.env", GOOD.trimEnd(), 0o600),
    );
    expect(checks.shapeOk).toBe(true);
    expect(token).toBe("a1b2c3d4".repeat(5));
  });

  test("the shape is exact, and it is the FILE that is matched", () => {
    const cases: [string, string][] = [
      ["uppercase hex", `CONTROL_PLANE_MINT_TOKEN='${"A1B2C3D4".repeat(5)}'\n`],
      ["39 characters", `CONTROL_PLANE_MINT_TOKEN='${"a".repeat(39)}'\n`],
      ["41 characters", `CONTROL_PLANE_MINT_TOKEN='${"a".repeat(41)}'\n`],
      ["unquoted", `CONTROL_PLANE_MINT_TOKEN=${"a".repeat(40)}\n`],
      ["double quotes", `CONTROL_PLANE_MINT_TOKEN="${"a".repeat(40)}"\n`],
      ["another name", `SOMETHING_ELSE='${"a".repeat(40)}'\n`],
      ["a second line", `${GOOD}EXTRA='surprise'\n`],
      ["empty", ""],
      // Everything below trims away to the ruled line, which is exactly why a
      // trimming check would have accepted bytes nobody ruled.
      ["a leading space", ` ${GOOD}`],
      ["a trailing space", `${GOOD.trimEnd()} \n`],
      ["a leading blank line", `\n${GOOD}`],
      ["an extra trailing blank line", `${GOOD}\n`],
      ["a leading tab", `\t${GOOD}`],
      ["carriage returns", GOOD.replace("\n", "\r\n")],
    ];
    for (const [label, contents] of cases) {
      const { checks, token } = inspectMintFile(
        write("m.env", contents, 0o600),
      );
      expect({ label, shapeOk: checks.shapeOk, token }).toEqual({
        label,
        shapeOk: false,
        token: "",
      });
    }
  });

  test("a missing file is all false", () => {
    const { checks, token } = inspectMintFile("/tmp/definitely-not-here.env");
    expect(checks).toEqual({
      present: false,
      regularFile: false,
      mode600: false,
      shapeOk: false,
    });
    expect(token).toBe("");
  });

  afterAll(() => {
    for (const dir of temps.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the provider credential file the import reads (D4)", () => {
  const temps: string[] = [];
  const write = (contents: string, mode = 0o600): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-contabo-"));
    temps.push(dir);
    const file = path.join(dir, "contabo.env");
    fs.writeFileSync(file, contents, { mode });
    fs.chmodSync(file, mode);
    return file;
  };
  const GOOD =
    "CONTABO_CLIENT_ID='id-value'\n" +
    "CONTABO_CLIENT_SECRET='secret-value'\n" +
    "CONTABO_API_USER='user@example.com'\n" +
    "CONTABO_API_PASSWORD='password-value'\n";

  test("the ruled shape passes and yields the four pairs", () => {
    const { checks, pairs } = inspectContaboFile(write(GOOD));
    expect(checks).toEqual({
      present: true,
      regularFile: true,
      mode600: true,
      shapeOk: true,
    });
    expect(pairs.map((p) => p.name).sort()).toEqual(
      [...CONTABO_SECRET_NAMES].sort(),
    );
    expect(pairs.find((p) => p.name === "CONTABO_API_USER")?.value).toBe(
      "user@example.com",
    );
    expect(contaboFileUsable(checks)).toBe(true);
  });

  test("order does not matter, and a missing final newline is still the shape", () => {
    const reversed = GOOD.trimEnd().split("\n").reverse().join("\n");
    const { checks, pairs } = inspectContaboFile(write(reversed));
    expect(checks.shapeOk).toBe(true);
    expect(pairs.length).toBe(4);
  });

  test("a readable-by-others file yields NO pairs", () => {
    const { checks, pairs } = inspectContaboFile(write(GOOD, 0o644));
    expect(checks.mode600).toBe(false);
    expect(contaboFileUsable(checks)).toBe(false);
    expect(pairs).toEqual([]);
  });

  test("a symlink is refused rather than followed", () => {
    const real = write(GOOD);
    const link = path.join(path.dirname(real), "link.env");
    fs.symlinkSync(real, link);
    const { checks, pairs } = inspectContaboFile(link);
    expect(checks.regularFile).toBe(false);
    expect(checks.present).toBe(true);
    expect(pairs).toEqual([]);
  });

  test("THREE OF FOUR IS A REFUSAL, not a partial import", () => {
    // A machine holding some of the credentials authenticates to nothing and
    // says nothing about why, which is the failure this shape check prevents.
    const three = GOOD.split("\n").slice(0, 3).join("\n") + "\n";
    expect(inspectContaboFile(write(three)).checks.shapeOk).toBe(false);
  });

  test("the shape is exact, and it is the FILE that is matched", () => {
    const cases: [string, string][] = [
      [
        "a name repeated",
        GOOD.replace("CONTABO_API_USER", "CONTABO_CLIENT_ID"),
      ],
      [
        "a name nobody ruled",
        GOOD.replace("CONTABO_API_USER", "CONTABO_OTHER"),
      ],
      [
        "a name outside the family",
        GOOD.replace("CONTABO_API_USER", "AWS_KEY"),
      ],
      ["a fifth line", `${GOOD}EXTRA='surprise'\n`],
      ["unquoted", GOOD.replace("'id-value'", "id-value")],
      ["double quotes", GOOD.replace("'id-value'", '"id-value"')],
      ["an empty value", GOOD.replace("'id-value'", "''")],
      ["a quote inside a value", GOOD.replace("'id-value'", "'id'value'")],
      ["a shell export prefix", `export ${GOOD}`],
      ["a comment line", `# provider credentials\n${GOOD}`],
      ["a leading blank line", `\n${GOOD}`],
      ["an extra trailing blank line", `${GOOD}\n`],
      ["a trailing space", GOOD.replace("'id-value'\n", "'id-value' \n")],
      ["carriage returns", GOOD.replace(/\n/g, "\r\n")],
      ["empty", ""],
    ];
    for (const [label, contents] of cases) {
      const { checks, pairs } = inspectContaboFile(write(contents));
      expect({ label, shapeOk: checks.shapeOk, pairs: pairs.length }).toEqual({
        label,
        shapeOk: false,
        pairs: 0,
      });
    }
  });

  test("a value carrying a line break cannot be built at all", () => {
    // The line split makes it impossible by construction, and validatePairs
    // refuses the same thing one layer down. Both are checked, because this is
    // the injection that would set a name nobody asked for.
    const broken = parseContabo(GOOD.replace("'id-value'", "'id\nvalue'"));
    expect(broken).toBeNull();
  });

  test("a missing file is all false", () => {
    const { checks, pairs } = inspectContaboFile(
      "/tmp/definitely-not-here.env",
    );
    expect(checks).toEqual({
      present: false,
      regularFile: false,
      mode600: false,
      shapeOk: false,
    });
    expect(pairs).toEqual([]);
  });

  afterAll(() => {
    for (const dir of temps.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
