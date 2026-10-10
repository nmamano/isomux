import { expect, test } from "bun:test";

for (const failClose of [false, true]) {
  test(`daemon error exits with a live server after closing stores (close throws: ${failClose})`, async () => {
    const script = `
      import { runCliEntry } from ${JSON.stringify(new URL("./cli-entry.ts", import.meta.url).pathname)};
      import { Reporter } from ${JSON.stringify(new URL("./report.ts", import.meta.url).pathname)};
      async function daemonCrash() {
        Bun.serve({ port: 0, fetch: () => new Response("live") });
        throw new Error("daemon failure password=private-test-value");
      }
      await runCliEntry(daemonCrash, async () => {
        console.log("stores-closed");
        if (${failClose}) throw new Error("close failure token=private-close-value");
      }, new Reporter(undefined, true), true);
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    let expired = false;
    const timeout = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 3000);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    clearTimeout(timeout);
    expect(expired).toBe(false);
    expect(code).toBe(1);
    expect(stdout).toContain("stores-closed");
    expect(stderr).toContain("daemonCrash");
    expect(stderr).not.toMatch(/private-test-value|private-close-value/);
    if (failClose) expect(stderr).toContain("close failure");
  });
}
