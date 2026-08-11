// Did this process's durable state outlive the last deployment?
//
// The provisioner keeps its private keys, run records, intent journal and audit
// log under one state root (config.ts). Deployed, that root has to sit on
// persistent storage: a deploy that replaced it would destroy the only key that
// can revoke our own access to a customer's box, which is the one promise the
// design says must never be quietly abandoned.
//
// "The directory is there" does not prove it. A fresh filesystem recreates the
// directory the moment `openStore` mkdirs it, so the boolean would be true on
// exactly the deployment that lost everything. A FILE nobody in the image wrote
// cannot be recreated that way, so the marker is the proof and the directory is
// not.
//
// The marker holds a deployment id, which is why it answers two questions
// rather than one: whether the state root survived AT ALL (the file was there),
// and whether it survived A NEW RELEASE (the id it named is not the current
// one). The second is the sharper fact, because a restart keeps a machine's
// filesystem regardless and only a deploy replaces it.
//
// TWO RULES ABOUT THE WRITE, and both are about not lying:
//
//   A FAILED REFRESH REFUSES. Reporting "the state survived" from a marker this
//   release could not rewrite would be evidence about the last deployment
//   dressed up as evidence about this one - and a state root that cannot be
//   written is not a key master at all, it is a machine that will fail the
//   first time a run needs to store a private key. So it throws, and the caller
//   never gets to serve.
//
//   THE REWRITE IS ATOMIC. Temp file, then rename. A write interrupted halfway
//   would otherwise leave a truncated marker, which is the proof of the last
//   deploy destroyed by the act of recording the current one.
//
// The id is opaque here on purpose. It arrives as an argument, so this module
// carries no knowledge of the platform it is deployed on.

import * as fs from "node:fs";
import * as path from "node:path";

/** Inside the state root, beside the runs and keys directories. */
export const MARKER_NAME = ".deployment";

export interface MarkerReading {
  /** A deployment id was supplied, so the marker means anything at all. */
  supported: boolean;
  /** The marker existed before this boot: the state root was carried over. */
  persisted: boolean;
  /** It named a DIFFERENT deployment: the state root survived a new release. */
  crossedRelease: boolean;
}

/**
 * The filesystem, as the two operations this module needs.
 *
 * A seam rather than a mock of `fs`: the case that has to be tested is "the old
 * marker reads fine and the refresh fails", which no arrangement of a real
 * directory produces on every machine - the obvious one, an unwritable
 * directory, does nothing at all when the tests run as root.
 */
export interface MarkerIo {
  /** The marker's contents, or null if there is not one to read. */
  read(file: string): string | null;
  /** Create the root if needed and replace the marker atomically, or throw. */
  replace(root: string, file: string, contents: string): void;
}

export const realMarkerIo: MarkerIo = {
  read(file) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      // Absent, or unreadable, which are the same claim: nothing was proved.
      return null;
    }
  },
  replace(root, file, contents) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, contents, { mode: 0o600 });
    try {
      fs.renameSync(temp, file);
    } catch (err) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // The rename failure is the news; a leftover temp file is not.
      }
      throw err;
    }
  },
};

/** What a refusal says. Fixed, and it quotes nothing it read. */
export const REFRESH_REFUSAL =
  "refusing to start: the state root could not be written, so this deployment " +
  "cannot record that it holds the durable state - and a state root that " +
  "cannot be written is not somewhere private keys can live";

/**
 * Read the marker, then record this deployment in it.
 *
 * With no deployment id nothing is read, nothing is written and nothing is
 * claimed: a local run has no release to cross, and inventing one would make
 * the boolean mean something different from what it means deployed.
 *
 * THROWS when the marker cannot be refreshed. The reading is computed first and
 * then discarded on that path, deliberately: a caller must not be able to use
 * the old marker's answer once the new one could not be written.
 */
export function readAndRefreshMarker(
  stateRoot: string,
  deploymentId: string | undefined,
  io: MarkerIo = realMarkerIo,
): MarkerReading {
  if (!deploymentId) {
    return { supported: false, persisted: false, crossedRelease: false };
  }
  const file = path.join(stateRoot, MARKER_NAME);
  const previous = (io.read(file) ?? "").trim();
  try {
    io.replace(stateRoot, file, `${deploymentId}\n`);
  } catch {
    // The cause is dropped rather than wrapped: an fs error carries a path, and
    // this refusal is read by whoever is looking at a deployed machine's log.
    throw new Error(REFRESH_REFUSAL);
  }
  return {
    supported: true,
    persisted: previous.length > 0,
    crossedRelease: previous.length > 0 && previous !== deploymentId,
  };
}
