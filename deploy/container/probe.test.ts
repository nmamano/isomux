import { expect, test } from "bun:test";

// A locked office (task cdd7883d) answers 503 with this header: healthy, or
// k8s liveness restarts the pod in a loop. A 503 without it is down. A wire
// value (server/lockdown.ts LOCKED_HEADER), so it is written out here.
const LOCKED_HEADER = "X-Isomux-Locked";
for (const [status, exitCode, locked] of [
  [200, 0, false],
  [401, 0, false],
  [302, 1, false],
  [503, 1, false],
  [503, 0, true],
  [500, 1, true],
] as const) {
  test(`image probe handles HTTP ${status}${locked ? " from a locked office" : ""}`, async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      // A probe that followed the redirect would read the 200 at /next.
      fetch: (req) =>
        new URL(req.url).pathname === "/next"
          ? new Response("ok")
          : new Response(null, {
              status,
              headers: {
                Location: "/next",
                ...(locked ? { [LOCKED_HEADER]: "1" } : {}),
              },
            }),
    });
    try {
      const child = Bun.spawn(
        [process.execPath, new URL("./probe.ts", import.meta.url).pathname],
        {
          env: { ...process.env, PORT: String(server.port) },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      expect(await child.exited).toBe(exitCode);
    } finally {
      await server.stop(true);
    }
  });
}
