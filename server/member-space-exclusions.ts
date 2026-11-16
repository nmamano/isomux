// What the backup leaves out of an isolated member's agent space
// (internal-docs/member-os-user-design.md, slice 3c). One matcher, used by
// the member's runner, which applies it while it walks their space as them
// (member-backup-send.ts), and by the office, which checks every path they
// list against it again (member-backup.ts). The runner bundle carries this
// file, so both sides run the same code.
//
// Derived from the office's lists, never a copy of them:
// - the credential and secret stores of BACKUP_EXCLUSIONS, with the office's
//   own glob semantics (tarGlobSource, rooted at their space): a backend login
//   name can occur in a configured home at any depth;
// - the backend credential names (BACKEND_CREDENTIAL_PATHS), at any depth;
// - the regenerable LOCATIONS (REGENERABLE_LOCATIONS), segment by segment: a
//   "*" segment is one folder name, so a "cache" folder deep in their data
//   stays in the copy;
// - their own: what the office makes again in their space, or what holds a
//   credential there.
// A path that matches is left out with everything under it.

import { BACKEND_CREDENTIAL_PATHS } from "./backend-credential-paths.ts";
import {
  BACKUP_EXCLUSIONS,
  REGENERABLE_LOCATIONS,
  tarGlobSource,
} from "./backup-exclusions.ts";

// The LOCATIONS of their own, relative to their agent space.
export const MEMBER_SPACE_OWN_LOCATIONS: readonly string[] = [
  // Each app's launcher and token (also in BACKUP_EXCLUSIONS), and the
  // secrets file of each of their apps (app-supervisor-router.ts).
  "apps/units",
  "apps/secrets",
  // The staging folders of a move (member-move-receive.ts).
  ".move-in",
  ".move-out",
  // Screenshots in the making (preview-capture.ts).
  "preview",
  // The skill folders the office builds for their agents again
  // (member-skill-folder.ts memberSpaceSkillFolderPath).
  "skill-folders",
];

// A root name no path segment can be: the office's globs are rooted at a
// state root's name, here at their space.
const ROOT = "\u0000space";

const GLOB = new RegExp(
  `^(?:${BACKUP_EXCLUSIONS.flatMap((entry) => entry.archivePatterns(ROOT))
    .map(tarGlobSource)
    .join("|")})(?:/.*)?$`,
);

const CREDENTIAL_NAMES = BACKEND_CREDENTIAL_PATHS.filter(
  (entry) => entry.backup !== "keep",
).map((entry) => entry.pattern);

const LOCATIONS = [...REGENERABLE_LOCATIONS, ...MEMBER_SPACE_OWN_LOCATIONS].map(
  (location) => location.split("/"),
);

// `rel` (relative to their space, "/" separated, no leading "/") or a folder
// above it matches a location: each segment equal, "*" any one name.
function underLocation(segments: string[]): boolean {
  return LOCATIONS.some(
    (location) =>
      location.length <= segments.length &&
      location.every((part, i) => part === "*" || part === segments[i]),
  );
}

export function memberSpaceExcluded(rel: string): boolean {
  if (rel === "") return false;
  const segments = rel.split("/");
  // A folder above `rel` that a credential name matches leaves it out too.
  for (let n = 1; n <= segments.length; n++) {
    const prefix = segments.slice(0, n).join("/");
    if (CREDENTIAL_NAMES.some((pattern) => pattern.test(prefix))) return true;
  }
  return GLOB.test(`${ROOT}/${rel}`) || underLocation(segments);
}
