// A member's WhatsApp state on disk: STATE_ROOT/whatsapp/<userId>/, holding
// the Baileys credentials (auth/) and link.json once the phone accepted the
// link. The directory is 0700 and its files 0600: whoever reads it has full
// access to the member's WhatsApp. STATE_ROOT/whatsapp/runtime/ holds the
// downloaded bridge package (server/whatsapp/installer.ts), not a member.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";

export interface WhatsAppLink {
  phone: string;
  linkedAt: number;
}

export const WHATSAPP_RUNTIME_DIR = "runtime";

const LINK_FILE = "link.json";

export function whatsappRoot(stateRoot: string): string {
  return join(stateRoot, "whatsapp");
}

// A user id names a directory: refuse anything that could leave the root or
// land on the runtime package.
function checkUserId(userId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(userId) || userId === WHATSAPP_RUNTIME_DIR)
    throw new Error("invalid user id for a WhatsApp directory");
}

export function memberDir(stateRoot: string, userId: string): string {
  checkUserId(userId);
  return join(whatsappRoot(stateRoot), userId);
}

// Creates the member's directory (0700) when missing and returns its path.
export function ensureMemberDir(stateRoot: string, userId: string): string {
  mkdirSync(whatsappRoot(stateRoot), { recursive: true, mode: 0o700 });
  const dir = memberDir(stateRoot, userId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function readLink(
  stateRoot: string,
  userId: string,
): WhatsAppLink | null {
  let raw: unknown;
  try {
    raw = JSON.parse(
      readFileSync(join(memberDir(stateRoot, userId), LINK_FILE), "utf8"),
    );
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { phone, linkedAt } = raw as Record<string, unknown>;
  return typeof phone === "string" && typeof linkedAt === "number"
    ? { phone, linkedAt }
    : null;
}

export function writeLink(
  stateRoot: string,
  userId: string,
  link: WhatsAppLink,
): void {
  const dir = ensureMemberDir(stateRoot, userId);
  const tmp = join(dir, LINK_FILE + ".tmp");
  writeFileSync(
    tmp,
    JSON.stringify({ phone: link.phone, linkedAt: link.linkedAt }) + "\n",
    { mode: 0o600 },
  );
  renameSync(tmp, join(dir, LINK_FILE));
}

// Deletes the member's session (credentials, link, id rings) and keeps their
// contact rows, for a new link after a dead one (routes-store.ts drops the
// rows if the new link has another phone).
export function removeSession(stateRoot: string, userId: string): void {
  const dir = memberDir(stateRoot, userId);
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir))
    if (entry !== "routes.json")
      rmSync(join(dir, entry), { recursive: true, force: true });
}

// The entries of the member's directory; none when it does not exist.
export function listMemberFiles(stateRoot: string, userId: string): string[] {
  const dir = memberDir(stateRoot, userId);
  return existsSync(dir) ? readdirSync(dir) : [];
}

export function removeMemberDir(stateRoot: string, userId: string): void {
  rmSync(memberDir(stateRoot, userId), { recursive: true, force: true });
}

// Every member directory, with whether it holds a link.json. A link.json that
// does not parse counts as none, so the boot sweep deletes that session; it
// cannot happen through writeLink, which renames a complete file into place.
export function listMemberDirs(
  stateRoot: string,
): { userId: string; hasLink: boolean }[] {
  const root = whatsappRoot(stateRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() &&
        d.name !== WHATSAPP_RUNTIME_DIR &&
        /^[A-Za-z0-9_-]+$/.test(d.name),
    )
    .map((d) => ({
      userId: d.name,
      hasLink: readLink(stateRoot, d.name) !== null,
    }));
}
