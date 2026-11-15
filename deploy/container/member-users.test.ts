import { expect, test } from "bun:test";

// The cases are in member-users_test.py (unittest), next to the helper.
test("the member users helper of the container", async () => {
  const proc = Bun.spawn(
    [
      "python3",
      "-B",
      new URL("./member-users_test.py", import.meta.url).pathname,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, err] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  expect({ code, err: code ? err : "" }).toEqual({ code: 0, err: "" });
});
