// node:os for the bundled safety plugin (safety-plugin-build.ts): the Isomux
// server's home in place of the OpenCode server's profile home. The policy's
// sources import only homedir from it; a build that needs another name fails.

declare const ISOMUX_SAFETY_HOME: string;

export function homedir(): string {
  return ISOMUX_SAFETY_HOME;
}
