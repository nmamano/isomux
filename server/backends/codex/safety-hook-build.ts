/** Build and verify the self-contained Codex safety-hook executable. */

import { chmodSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";

export interface BuiltCodexSafetyHook {
  executablePath: string;
  executableSha256: string;
  sourceSha256: string;
  sourceFiles: string[];
  sizeBytes: number;
}

function sha256(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

async function outputText(stream: ReadableStream<Uint8Array> | null) {
  return stream ? await new Response(stream).text() : "";
}

export async function hashCodexSafetyHookSources(): Promise<{
  sha256: string;
  files: string[];
}> {
  const entrypoint = join(import.meta.dir, "safety-hook.ts");
  const repositoryRoot = resolve(import.meta.dir, "../../..");
  const analysis = await Bun.build({
    entrypoints: [entrypoint],
    target: "bun",
    metafile: true,
  });
  if (!analysis.success || !analysis.metafile) {
    throw new Error(
      `Codex safety-hook dependency analysis failed: ${JSON.stringify(analysis.logs)}`,
    );
  }
  const inputs = Object.keys(analysis.metafile.inputs)
    .map((input) => resolve(input))
    .sort();
  const files = inputs.map((input) => relative(repositoryRoot, input));
  const hasher = new Bun.CryptoHasher("sha256");
  for (let index = 0; index < inputs.length; index++) {
    const path = Buffer.from(files[index]);
    const source = readFileSync(inputs[index]);
    const lengths = Buffer.allocUnsafe(8);
    lengths.writeUInt32BE(path.byteLength, 0);
    lengths.writeUInt32BE(source.byteLength, 4);
    hasher.update(lengths);
    hasher.update(path);
    hasher.update(source);
  }
  return { sha256: hasher.digest("hex"), files };
}

export async function buildCodexSafetyHook(
  outputPath: string,
): Promise<BuiltCodexSafetyHook> {
  const entrypoint = join(import.meta.dir, "safety-hook.ts");
  const source = await hashCodexSafetyHookSources();
  const executablePath = resolve(outputPath);
  const define = `ISOMUX_SAFETY_HOOK_SOURCE_SHA256=${JSON.stringify(source.sha256)}`;
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      entrypoint,
      "--outfile",
      executablePath,
      "--define",
      define,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    build.exited,
    outputText(build.stdout),
    outputText(build.stderr),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Codex safety-hook build failed with exit ${exitCode}: ${stderr || stdout}`,
    );
  }
  chmodSync(executablePath, 0o700);

  const stamp = Bun.spawn([executablePath, "--source-hash"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stampExit, stampedHash, stampError] = await Promise.all([
    stamp.exited,
    outputText(stamp.stdout),
    outputText(stamp.stderr),
  ]);
  if (stampExit !== 0 || stampedHash.trim() !== source.sha256) {
    throw new Error(
      `Codex safety-hook source stamp mismatch: expected ${source.sha256}, ` +
        `received ${stampedHash.trim() || "<empty>"}${stampError ? ` (${stampError.trim()})` : ""}`,
    );
  }

  const executable = readFileSync(executablePath);
  return {
    executablePath,
    executableSha256: sha256(executable),
    sourceSha256: source.sha256,
    sourceFiles: source.files,
    sizeBytes: statSync(executablePath).size,
  };
}
