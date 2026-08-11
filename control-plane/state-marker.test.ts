// The marker, and the failure it exists to catch.
//
// The mistake it replaces is "the state directory is there": every case below
// starts from a directory that exists, because that is the condition a fresh
// filesystem reproduces for free.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MARKER_NAME,
  REFRESH_REFUSAL,
  readAndRefreshMarker,
} from "./state-marker.ts";

const temps: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-marker-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("the deployment marker", () => {
  test("a first boot claims nothing, and leaves the marker behind", () => {
    const root = tempRoot();
    const first = readAndRefreshMarker(root, "release-1");
    expect(first).toEqual({
      supported: true,
      persisted: false,
      crossedRelease: false,
    });
    expect(fs.existsSync(path.join(root, MARKER_NAME))).toBe(true);
  });

  test("a restart on the same release: state survived, no release crossed", () => {
    const root = tempRoot();
    readAndRefreshMarker(root, "release-1");
    expect(readAndRefreshMarker(root, "release-1")).toEqual({
      supported: true,
      persisted: true,
      crossedRelease: false,
    });
  });

  test("a redeploy that kept the state root crosses a release", () => {
    const root = tempRoot();
    readAndRefreshMarker(root, "release-1");
    expect(readAndRefreshMarker(root, "release-2")).toEqual({
      supported: true,
      persisted: true,
      crossedRelease: true,
    });
  });

  test("A DIRECTORY THAT EXISTS PROVES NOTHING - the marker is the proof", () => {
    const root = tempRoot();
    readAndRefreshMarker(root, "release-1");
    // Exactly what a redeploy onto a fresh filesystem produces: the state root
    // is recreated, the marker is not, because nothing in the image writes it.
    fs.rmSync(path.join(root, MARKER_NAME));
    expect(fs.existsSync(root)).toBe(true);
    expect(readAndRefreshMarker(root, "release-2")).toEqual({
      supported: true,
      persisted: false,
      crossedRelease: false,
    });
  });

  test("without a deployment id nothing is claimed and nothing is written", () => {
    const root = tempRoot();
    expect(readAndRefreshMarker(root, undefined)).toEqual({
      supported: false,
      persisted: false,
      crossedRelease: false,
    });
    expect(readAndRefreshMarker(root, "")).toEqual({
      supported: false,
      persisted: false,
      crossedRelease: false,
    });
    expect(fs.existsSync(path.join(root, MARKER_NAME))).toBe(false);
  });

  test("a state root that does not exist yet is created", () => {
    const root = path.join(tempRoot(), "nested", "state");
    expect(readAndRefreshMarker(root, "release-1").persisted).toBe(false);
    expect(fs.existsSync(path.join(root, MARKER_NAME))).toBe(true);
  });

  test("a marker that cannot be replaced REFUSES, whatever was there before", () => {
    // The case the seam exists for: the old marker reads perfectly, and this
    // release cannot record itself. Answering "persisted: true" here would be
    // evidence about the LAST deployment presented as evidence about this one.
    const root = tempRoot();
    const io = {
      read: () => "release-1\n",
      replace: () => {
        throw new Error(
          "EROFS: read-only file system, open '/data/secret-ish'",
        );
      },
    };
    const failure = (() => {
      try {
        readAndRefreshMarker(root, "release-2", io);
        return "IT DID NOT REFUSE";
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    })();
    expect(failure).toBe(REFRESH_REFUSAL);
    // The refusal is fixed: the underlying error's path does not travel with it.
    expect(failure).not.toContain("/data");
    expect(failure).not.toContain("EROFS");
  });

  test("a state root whose parent is a file refuses on the real filesystem", () => {
    // Uid-independent, unlike an unwritable directory, which does nothing at
    // all when a suite runs as root.
    const parent = path.join(tempRoot(), "not-a-directory");
    fs.writeFileSync(parent, "");
    expect(() =>
      readAndRefreshMarker(path.join(parent, "state"), "r1"),
    ).toThrow(REFRESH_REFUSAL);
  });

  test("a marker path occupied by a directory refuses rather than reporting", () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, MARKER_NAME));
    fs.writeFileSync(path.join(root, MARKER_NAME, "occupied"), "x");
    expect(() => readAndRefreshMarker(root, "release-1")).toThrow(
      REFRESH_REFUSAL,
    );
  });

  test("the replacement is atomic, and leaves no temp file behind", () => {
    const root = tempRoot();
    readAndRefreshMarker(root, "release-1");
    readAndRefreshMarker(root, "release-2");
    expect(fs.readdirSync(root)).toEqual([MARKER_NAME]);
    expect(fs.readFileSync(path.join(root, MARKER_NAME), "utf8")).toBe(
      "release-2\n",
    );
  });

  test("an unreadable marker reads as absent, and the refresh still happens", () => {
    const root = tempRoot();
    const io = {
      read: () => null,
      replace: () => {},
    };
    expect(readAndRefreshMarker(root, "release-1", io)).toEqual({
      supported: true,
      persisted: false,
      crossedRelease: false,
    });
  });
});
