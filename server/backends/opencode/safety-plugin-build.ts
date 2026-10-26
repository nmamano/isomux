import { join } from "node:path";
import type { OpenCodeShellVariable } from "./safety-plugin-tool.ts";

const entry = join(import.meta.dir, "safety-plugin.ts");
const osShim = join(import.meta.dir, "safety-plugin-os.ts");

// The roots the policy derives from the environment, as the Isomux server
// process sees them: Claude's hook evaluates there. env holds every variable
// the policy's sources read.
export interface OpenCodeSafetyRoots {
  home: string;
  env: { ISOMUX_HOME: string; ISOMUX_ADMIN_SOCKET: string };
}

// The shell variables (OPENCODE_SHELL_VARIABLES) as the server sets them
// from the profile, and as the agents' OS user has them (null: unset). The
// shell hook gives a shell the user's value in place of the profile's, and
// the policy resolves ~, $HOME and $TMPDIR from the user's.
export interface OpenCodeSafetyShell {
  user: Record<OpenCodeShellVariable, string | null>;
  profile: Record<OpenCodeShellVariable, string>;
}

// safety-plugin.ts as one self-contained module with the roots baked in: no
// read of the OpenCode server's HOME or environment is left, and it imports
// only Bun built-ins, so no config layer can change what it resolves.
export async function buildOpenCodeSafetyPlugin(
  roots: OpenCodeSafetyRoots,
  shell: OpenCodeSafetyShell,
): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    format: "esm",
    define: {
      ISOMUX_SAFETY_HOME: JSON.stringify(roots.home),
      ISOMUX_SAFETY_ENV: JSON.stringify(roots.env),
      ISOMUX_SAFETY_SHELL: JSON.stringify(shell),
    },
    plugins: [
      {
        // Bun resolves built-ins before onResolve, so the shim goes in by
        // rewriting the import in each source file.
        name: "isomux-safety-roots",
        setup(build) {
          build.onLoad({ filter: /\.ts$/ }, async (args) => {
            const text = await Bun.file(args.path).text();
            return {
              contents:
                args.path === osShim
                  ? text
                  : text
                      .replace(
                        /from "(node:)?os"/g,
                        `from ${JSON.stringify(osShim)}`,
                      )
                      .replaceAll("process.env", "ISOMUX_SAFETY_ENV"),
              loader: "ts",
            };
          });
        },
      },
    ],
  });
  if (!result.success || !result.outputs[0])
    throw new Error(
      `The OpenCode safety plugin did not build: ${result.logs.map(String).join("; ")}`,
    );
  return result.outputs[0].text();
}
