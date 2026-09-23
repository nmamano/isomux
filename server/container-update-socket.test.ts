import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("container client half-closes one tag request and waits for the helper response", async () => {
  const dir = mkdtempSync(join(tmpdir(), "isomux-update-socket-"));
  const path = join(dir, "request.sock");
  const peer = Bun.spawn(
    [
      "python3",
      "-u",
      "-c",
      `
import socket, sys
from pathlib import Path
with socket.socket(socket.AF_UNIX) as listener:
    listener.bind(sys.argv[1])
    listener.listen(1)
    print("ready", flush=True)
    conn, _ = listener.accept()
    with conn:
        conn.settimeout(3)
        data = b""
        while chunk := conn.recv(257):
            data += chunk
        Path(sys.argv[2]).write_bytes(data)
        conn.sendall(b'{"ok":true}\\n')
`,
      path,
      join(dir, "received"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    await peer.stdout.getReader().read();
    const client = Bun.spawn([
      "python3",
      "-B",
      "-c",
      `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("client", sys.argv[1])
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)
sys.exit(0 if client.request("v2099.1.2", sys.argv[2]) else 1)
`,
      new URL("../deploy/container/update-client.py", import.meta.url).pathname,
      path,
    ]);
    expect(await client.exited).toBe(0);
    expect(await peer.exited).toBe(0);
    const received = readFileSync(join(dir, "received"), "utf8");
    expect(JSON.parse(received)).toEqual({ tag: "v2099.1.2" });
    expect(received.endsWith("\n")).toBe(true);
  } finally {
    peer.kill();
    await peer.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
