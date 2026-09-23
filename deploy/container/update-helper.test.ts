import { expect, test } from "bun:test";

test("root helper only accepts the fixed release operation", async () => {
  const proc = Bun.spawn(
    [
      "python3",
      "-B",
      new URL("./update-helper_test.py", import.meta.url).pathname,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, err] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  expect({ code, err: code ? err : "" }).toEqual({ code: 0, err: "" });
});
