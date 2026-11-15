// An upload into a member's agent folder (server/attachment-prompt.ts,
// prepareMemberCopies), as the member: from the copy that the office wrote
// in the member's share to <folder>/attachments/<name>. The same rules as
// the office's copyAttachmentsInto: the attachments folder is a real folder
// (made 0700 when missing), a regular file there is replaced, anything else
// is refused, and the file is made without following a link. The bytes go
// from file to file; none cross the runner's socket.
import { constants } from "fs";
import * as fsp from "fs/promises";
import { basename, isAbsolute, join } from "path";
import { runEntry } from "./io.ts";

await runEntry(async (input) => {
  const req = input as {
    source?: unknown;
    folder?: unknown;
    name?: unknown;
  } | null;
  const { source, folder, name } = req ?? {};
  if (typeof source !== "string" || !isAbsolute(source))
    throw new Error("attachment-copy needs an absolute source");
  if (typeof folder !== "string" || !isAbsolute(folder))
    throw new Error("attachment-copy needs an absolute folder");
  if (
    typeof name !== "string" ||
    !name ||
    name !== basename(name) ||
    name === "." ||
    name === ".."
  )
    throw new Error("attachment-copy needs a file name");
  const dir = join(await fsp.realpath(folder), "attachments");
  let st = await fsp.lstat(dir).catch(() => null);
  if (!st) {
    await fsp.mkdir(dir, { mode: 0o700 });
    st = await fsp.lstat(dir);
  }
  if (!st.isDirectory()) throw new Error(`${dir} is not a folder`);
  const target = join(dir, name);
  const existing = await fsp.lstat(target).catch(() => null);
  if (existing && !existing.isFile())
    throw new Error(`${target} is not a file`);
  if (existing) await fsp.unlink(target);
  await fsp.copyFile(source, target, constants.COPYFILE_EXCL);
  await fsp.chmod(target, 0o600);
  return { path: target };
});
