import { expect, test } from "bun:test";
import { createSetupHandler } from "./bootstrap.ts";

test("public setup requires its secret and origin and closes after owner creation", async () => {
  let owner = false;
  let claims = 0;
  const key = "synthetic-setup-key-32-characters-long";
  const handler = createSetupHandler({
    origin: "https://office.example.com",
    key,
    hasOwner: () => owner,
    complete: () => {},
    claim: async () => {
      owner = true;
      claims++;
      return "__Host-isomux_session=synthetic; Secure; HttpOnly; Path=/";
    },
  });
  const post = (secret: string, origin = "https://office.example.com") =>
    handler(
      new Request("https://office.example.com/setup", {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ key: secret, name: "Owner" }),
      }),
    );
  expect((await post("wrong")).status).toBe(403);
  expect((await post(key, "https://other.example.com")).status).toBe(403);
  expect(claims).toBe(0);
  const accepted = await post(key);
  expect(accepted.status).toBe(200);
  expect(accepted.headers.get("set-cookie")).toContain("Secure; HttpOnly");
  expect(claims).toBe(1);
  expect((await post(key)).status).toBe(409);
  expect(claims).toBe(1);
});
