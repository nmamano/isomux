import { expect, test } from "bun:test";

for (const [status, exitCode] of [[200, 0], [401, 0], [302, 1], [503, 1]]) {
  test(`image probe handles HTTP ${status}`, async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => new Response(null, { status, headers: { Location: "/" } }),
    });
    try {
      const child = Bun.spawn([process.execPath, new URL("./probe.ts", import.meta.url).pathname], {
        env: { ...process.env, PORT: String(server.port) },
        stdout: "ignore", stderr: "pipe",
      });
      expect(await child.exited).toBe(exitCode);
    } finally {
      await server.stop(true);
    }
  });
}
