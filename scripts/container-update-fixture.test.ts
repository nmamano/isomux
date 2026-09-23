import { expect, test } from "bun:test";

test("acceptance client sends HTTP requests and reads Bun cookie headers", async () => {
  let received = "";
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      received = await request.text();
      expect(request.headers.get("cookie")).toBe("fixture=member");
      expect(request.headers.get("origin")).toBe(
        "https://fixture.example.invalid",
      );
      return new Response("ok", {
        headers: { "Set-Cookie": "fixture=owner; HttpOnly" },
      });
    },
  });
  try {
    const client = Bun.spawn(
      [
        "python3",
        "-B",
        "-c",
        `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("fixture", sys.argv[1])
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
fixture.PORT = int(sys.argv[2])
status, headers, body = fixture.http("/setup", "POST", {"name":"Fixture"}, "fixture=member", form=True)
assert status == 200 and headers["set-cookie"].split(";", 1)[0] == "fixture=owner"
assert body == b"ok"
`,
        new URL("./check-container-update-fixture.py", import.meta.url)
          .pathname,
        String(server.port),
      ],
      { stderr: "pipe" },
    );
    const [code, err] = await Promise.all([
      client.exited,
      new Response(client.stderr).text(),
    ]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(new URLSearchParams(received).get("name")).toBe("Fixture");
  } finally {
    await server.stop(true);
  }
});
