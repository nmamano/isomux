// The judgements the one approved preview rests on, exercised against shaped
// canaries before a real token ever reaches the program that uses them.

import { describe, expect, test } from "bun:test";
import {
  ROOT_DIRECTORY,
  settingsHoldWithInstallCommand,
  buildEvidenceAllHold,
  deploymentIsOurs,
  judgeBuild,
  judgeSettings,
  settingsAllHold,
  uploadSizeFrom,
} from "./vercel-preview.ts";

const CANARY_TOKEN = "isomuxD3PublicCanary0123456789ab";

const ASKED_FOR = {
  id: "prj_ours",
  name: "isomux-control-plane",
  framework: "nextjs",
  rootDirectory: ROOT_DIRECTORY,
  sourceFilesOutsideRootDirectory: true,
  installCommand: null,
  buildCommand: null,
  outputDirectory: null,
};

/** A Next.js build on Vercel, in the shape its log takes. */
const GOOD_LOG = `
Running "install" command: \`cd ../.. && bun install --frozen-lockfile && cd control-plane/web && bun install --frozen-lockfile\`...
Detected bun.lock, using bun
Running "build" command: \`next build\`...
▲ Next.js 16.3.0
Creating an optimized production build ...
Compiled successfully
Route (app)
○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
Build Completed
`;

describe("what the project must be", () => {
  test("the asked-for project holds every check", () => {
    const verdict = judgeSettings(ASKED_FOR);
    expect(settingsAllHold(verdict)).toBe(true);
  });

  test("EVERY setting is load bearing, one at a time", () => {
    const wrong: [string, unknown][] = [
      ["rootDirectory", "control-plane"],
      ["rootDirectory", null],
      ["sourceFilesOutsideRootDirectory", false],
      ["sourceFilesOutsideRootDirectory", null],
      ["framework", "nextjs-legacy"],
      ["framework", null],
    ];
    for (const [key, value] of wrong) {
      const verdict = judgeSettings({ ...ASKED_FOR, [key]: value });
      expect({ key, value, holds: settingsAllHold(verdict) }).toEqual({
        key,
        value,
        holds: false,
      });
    }
  });

  test("AN EMPTY COMMAND IS A COMMAND, not an unset one", () => {
    // The install/build resolution question is only answerable if nothing
    // overrode it, and "" overrides it.
    for (const key of ["installCommand", "buildCommand", "outputDirectory"]) {
      const verdict = judgeSettings({ ...ASKED_FOR, [key]: "" });
      expect({ key, holds: settingsAllHold(verdict) }).toEqual({
        key,
        holds: false,
      });
    }
  });

  test("absent and null both count as unset", () => {
    const bare = {
      framework: "nextjs",
      rootDirectory: ROOT_DIRECTORY,
      sourceFilesOutsideRootDirectory: true,
    };
    expect(settingsAllHold(judgeSettings(bare))).toBe(true);
  });
});

describe("what the build log proves", () => {
  test("a successful Next build holds every question", () => {
    expect(buildEvidenceAllHold(judgeBuild(GOOD_LOG))).toBe(true);
  });

  test("AN UNRESOLVED IMPORT OUTSIDE THE ROOT IS CAUGHT", () => {
    const failed = `
Running "install" command: \`bun install --frozen-lockfile\`...
Detected bun.lock, using bun
▲ Next.js 16.3.0
Module not found: Can't resolve '../../store'
Build failed
`;
    const evidence = judgeBuild(failed);
    expect(evidence.importsOutsideRootResolved).toBe(false);
    expect(buildEvidenceAllHold(evidence)).toBe(false);
  });

  test("a build that never compiled does not pass by staying silent", () => {
    // No module error, but no compile either. "Nothing went wrong" is not the
    // same as "it worked", and this is the conjunction that says so.
    const stalled = `
Running "install" command: \`bun install --frozen-lockfile\`...
Detected bun.lock, using bun
▲ Next.js 16.3.0
Error: build machine ran out of memory
`;
    expect(judgeBuild(stalled).importsOutsideRootResolved).toBe(false);
  });

  test("THE LANDING PAGE'S BUILD COMMAND IS CAUGHT IF IT EVER RUNS", () => {
    // If the root vercel.json were read, this is what the log would carry.
    const landing = `${GOOD_LOG}
Running "build" command: \`bun install && mkdir -p site/demo && bun build ui/demo-entry.tsx --outdir site/demo\`...
`;
    const evidence = judgeBuild(landing);
    expect(evidence.landingBuildCommandAbsent).toBe(false);
    expect(buildEvidenceAllHold(evidence)).toBe(false);
  });

  test("an empty or unreadable log proves nothing", () => {
    expect(buildEvidenceAllHold(judgeBuild(""))).toBe(false);
  });
});

describe("which deployment is ours", () => {
  const START = 1_000_000;

  test("this project, at or after the invocation", () => {
    expect(
      deploymentIsOurs(
        { projectId: "prj_ours", createdAt: START + 5 },
        "prj_ours",
        START,
      ),
    ).toBe(true);
  });

  test("A STALE ROW FROM THE SAME PROJECT IS NOT THIS RUN", () => {
    expect(
      deploymentIsOurs(
        { projectId: "prj_ours", createdAt: START - 1 },
        "prj_ours",
        START,
      ),
    ).toBe(false);
  });

  test("another project's deployment is never ours", () => {
    expect(
      deploymentIsOurs(
        { projectId: "prj_landing", createdAt: START + 5 },
        "prj_ours",
        START,
      ),
    ).toBe(false);
  });

  test("a row with no usable timestamp is refused", () => {
    expect(
      deploymentIsOurs(
        { projectId: "prj_ours", createdAt: "recently" },
        "prj_ours",
        START,
      ),
    ).toBe(false);
    expect(deploymentIsOurs({}, "prj_ours", START)).toBe(false);
  });
});

describe("what may leave a child's output", () => {
  test("a size-shaped match, and nothing else", () => {
    expect(uploadSizeFrom("Uploading [====================] (14.3MB)")).toBe(
      "14.3MB",
    );
    expect(uploadSizeFrom("Uploading files 12.0 KB")).toBe("12.0KB");
  });

  test("A CHILD THAT PRINTS A CREDENTIAL YIELDS NOTHING", () => {
    const leaky = `Error: token ${CANARY_TOKEN} was rejected by https://api.vercel.com`;
    const seen = uploadSizeFrom(leaky);
    expect(seen).toBe("unreadable");
    expect(seen).not.toContain(CANARY_TOKEN);
  });

  test("no output at all is unreadable, not zero", () => {
    // Zero would be a claim about the upload. "unreadable" is a claim about us.
    expect(uploadSizeFrom("")).toBe("unreadable");
  });
});

describe("the invariants once the install command is set", () => {
  const SET = {
    framework: "nextjs",
    rootDirectory: ROOT_DIRECTORY,
    sourceFilesOutsideRootDirectory: true,
    installCommand: "cd ../.. && bun install --frozen-lockfile",
    buildCommand: null,
    outputDirectory: null,
  };

  test("A SET INSTALL COMMAND IS NOT A FAILED INVARIANT", () => {
    // The regression this pins: `settingsAllHold` requires every field true,
    // including `installCommandUnset`, which is deliberately false once we set
    // the command on purpose. It made a correct project look wrong and stopped
    // a run for no reason.
    const verdict = judgeSettings(SET);
    expect(verdict.installCommandUnset).toBe(false);
    expect(settingsAllHold(verdict)).toBe(false);
    expect(settingsHoldWithInstallCommand(verdict)).toBe(true);
  });

  test("everything else is still load bearing", () => {
    for (const [key, value] of [
      ["rootDirectory", "control-plane"],
      ["sourceFilesOutsideRootDirectory", false],
      ["framework", null],
      ["buildCommand", "next build"],
      ["outputDirectory", "site"],
    ] as [string, unknown][]) {
      const verdict = judgeSettings({ ...SET, [key]: value });
      expect({ key, holds: settingsHoldWithInstallCommand(verdict) }).toEqual({
        key,
        holds: false,
      });
    }
  });
});
