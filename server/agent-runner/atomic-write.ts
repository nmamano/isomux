// A file write a reader never sees half done: the bytes go to a new file in
// the same folder, created with the final mode, which then replaces the
// target by rename. Used by AgentFs.writeText's `atomic` option, on the
// office host and in the agent runner.
import { randomBytes } from "crypto";
import { chmod, rename, rm, writeFile } from "fs/promises";
import { basename, dirname, join } from "path";

export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  mode: number,
): Promise<void> {
  const temp = join(
    dirname(path),
    `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temp, data, { mode, flag: "wx" });
    // The umask may have taken bits of `mode` away.
    await chmod(temp, mode);
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}
