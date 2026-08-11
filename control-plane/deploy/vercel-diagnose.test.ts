// The failure vocabulary: it must name a cause when there is one, and admit it
// cannot when there is not.

import { describe, expect, test } from "bun:test";
import {
  anyClassified,
  classify,
  configEvidence,
  moduleEvidence,
} from "./vercel-diagnose.ts";

const CANARY_TOKEN = "isomuxD3PublicCanary0123456789ab";

describe("classifying a failed build", () => {
  test("the cause this deployment actually hit", () => {
    const log =
      "Error: The specified Root Directory “control-plane/web” does not exist.";
    const classes = classify(log);
    expect(classes.rootDirectoryMissing).toBe(true);
    expect(anyClassified(classes)).toBe(true);
  });

  test("each class is reachable on its own", () => {
    const cases: [keyof ReturnType<typeof classify>, string][] = [
      ["nothingUploaded", "No files were uploaded"],
      ["packageJsonMissing", "Could not read package.json"],
      ["installFailed", "npm ERR! install failed"],
      [
        "lockfileRefused",
        "error: lockfile had changes, but lockfile is frozen",
      ],
      ["nextMissing", "sh: next: not found"],
      [
        "moduleOutsideRootUnresolved",
        "Module not found: Can't resolve '../../store'",
      ],
      ["outputDirectoryMissing", "Error: No Output Directory named 'public'"],
      ["buildCommandExited", 'Command "next build" exited with 1'],
      ["notAuthorized", "Error: not authorized"],
    ];
    for (const [key, log] of cases) {
      expect({ key, hit: classify(log)[key] }).toEqual({ key, hit: true });
    }
  });

  test("AN UNLISTED CAUSE IS ADMITTED, NOT INVENTED", () => {
    // A log we have no vocabulary for must not quietly match something else:
    // "unclassified" is the honest answer and the one that sends a human to
    // the dashboard.
    const log = "Error: the builder encountered a situation nobody has named";
    expect(anyClassified(classify(log))).toBe(false);
  });

  test("an empty log classifies nothing", () => {
    expect(anyClassified(classify(""))).toBe(false);
  });

  test("a log carrying a credential still yields only booleans", () => {
    const classes = classify(`Error: token ${CANARY_TOKEN} rejected`);
    for (const value of Object.values(classes)) {
      expect(typeof value).toBe("boolean");
    }
  });
});

describe("whose configuration the builder used", () => {
  test("THE LANDING PAGE'S BUILD IS UNMISTAKABLE", () => {
    const log =
      'Running "build" command: `bun install && mkdir -p site/demo && ' +
      "bun build ui/demo-entry.tsx --outdir site/demo && bun run build:docs`...";
    const evidence = configEvidence(log);
    expect(evidence.landingDemoBuild).toBe(true);
    expect(evidence.landingDocsBuild).toBe(true);
    expect(evidence.landingOutputDirectory).toBe(true);
  });

  test("a control-plane build names its own root directory instead", () => {
    const log = 'Running "install" command in control-plane/web: `bun install`';
    const evidence = configEvidence(log);
    expect(evidence.nestedWebBuild).toBe(true);
    expect(evidence.landingDemoBuild).toBe(false);
    expect(evidence.landingDocsBuild).toBe(false);
  });

  test("an empty log claims neither", () => {
    const evidence = configEvidence("");
    expect(Object.values(evidence).every((v) => v === false)).toBe(true);
  });
});

describe("which module could not be resolved", () => {
  test("A RELATIVE SPECIFIER AND A PACKAGE NAME MEAN OPPOSITE THINGS", () => {
    const outside = `Module not found: Can't resolve '../../store'`;
    expect(moduleEvidence(outside).unresolvedOutsideRootImport).toBe(true);
    expect(moduleEvidence(outside).unresolvedDependency).toBe(false);

    const dependency = `Module not found: Can't resolve 'pg'`;
    expect(moduleEvidence(dependency).unresolvedOutsideRootImport).toBe(false);
    expect(moduleEvidence(dependency).unresolvedDependency).toBe(true);
  });

  test("only the web package's own dependencies are named", () => {
    const log = `Can't resolve 'pg'\nCan't resolve 'some-other-lib'`;
    const evidence = moduleEvidence(log);
    expect(evidence.unresolvedWebDependencies).toEqual(["pg"]);
    // The unlisted one still counts as a dependency failure; it is simply not
    // named, because the vocabulary is closed.
    expect(evidence.unresolvedDependency).toBe(true);
  });

  test("a subpath import of a known dependency still names it", () => {
    expect(
      moduleEvidence(`Can't resolve 'next/navigation'`)
        .unresolvedWebDependencies,
    ).toEqual(["next"]);
  });

  test("a clean log names nothing", () => {
    const evidence = moduleEvidence("Compiled successfully");
    expect(evidence.unresolvedOutsideRootImport).toBe(false);
    expect(evidence.unresolvedDependency).toBe(false);
    expect(evidence.unresolvedWebDependencies).toEqual([]);
  });
});

describe("the classifier does not fire on a healthy build", () => {
  test("OUR OWN INSTALL COMMAND IS NOT A LOCKFILE REFUSAL", () => {
    // It was: the pattern matched the bare `--frozen-lockfile` flag, which this
    // build's own successful command carries, and reported a failure class on
    // a deployment that reached READY.
    const healthy =
      'Running "install" command: `cd ../.. && bun install ' +
      "--frozen-lockfile && cd control-plane/web && bun install " +
      "--frozen-lockfile`...";
    expect(classify(healthy).lockfileRefused).toBe(false);
    expect(anyClassified(classify(healthy))).toBe(false);
  });
});
