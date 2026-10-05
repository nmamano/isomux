// pagerSettings.* handlers: a failure on the settings path answers 500 with
// a fixed log line, and never rethrows to the executor (which logs a thrown
// error in full) - so an error that quotes the webhook URL is never logged.

import { describe, it, expect, afterEach } from "bun:test";
import { pagerSettingsHandlers } from "./pager-settings.ts";
import type { RouteHandlerContext } from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import { USER_CAPABILITIES } from "../../identity/index.ts";

const URL_ = "https://discord.com/api/webhooks/123/SeCrEtToKeN";

const identity: Identity = {
  scope: "user",
  userId: "u1",
  role: "member",
  capabilities: USER_CAPABILITIES,
};

function ctx(body: unknown = undefined): RouteHandlerContext {
  return {
    identity,
    params: { username: "boss" },
    body,
    rawBody: "",
    query: new URLSearchParams(),
    req: new Request("http://localhost/"),
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function captureConsole(): string[] {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  restore = () => (console.error = orig);
  return lines;
}

describe("pager settings handlers: failures", () => {
  it("a failed save or test answers 500 and logs no error text", async () => {
    const lines = captureConsole();
    const boom = () => {
      throw new Error(`EACCES: cannot save ${URL_}`);
    };
    const handlers = pagerSettingsHandlers({
      settings: { get: boom, update: boom, setHoldUntil: boom },
      rescheduleMember: () => {},
      sendTest: () => Promise.reject(new Error(`fetch ${URL_}`)),
    });
    for (const [opId, body] of [
      ["pagerSettings.get", undefined],
      ["pagerSettings.update", { webhookUrl: URL_ }],
      ["pagerSettings.test", undefined],
    ] as const) {
      const res = await handlers[opId](ctx(body));
      expect(res).toMatchObject({ kind: "error", status: 500 });
      expect(JSON.stringify(res)).not.toContain("SeCrEtToKeN");
    }
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).not.toContain("SeCrEtToKeN");
  });
});
