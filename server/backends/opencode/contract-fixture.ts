import { writeFile } from "node:fs/promises";

const CREDENTIAL_SHAPE =
  /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|bearer\s+[a-z0-9._~-]+)/i;

export async function writeSafeContractFixture(
  path: string,
  shapes: string[],
): Promise<void> {
  const serialized = `${JSON.stringify(shapes, null, 2)}\n`;
  if (CREDENTIAL_SHAPE.test(serialized)) {
    throw new Error(
      "Refusing to write an OpenCode contract fixture with a credential-shaped value.",
    );
  }
  await writeFile(path, serialized, { mode: 0o600 });
}
