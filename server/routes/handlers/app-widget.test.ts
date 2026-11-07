// apps.widget is polled by every open widget tab (each minute, each second
// after a change): its two slow reads, the files revision and the serving
// probe, run at the same time (task 459936c8).

import { expect, it } from "bun:test";
import { appWidgetHandlers } from "./app-widget.ts";
import type { RouteHandlerContext } from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import { USER_CAPABILITIES } from "../../identity/index.ts";
import type { AppRecord } from "../../../shared/types.ts";

const identity: Identity = {
  scope: "user",
  userId: "u1",
  role: "member",
  capabilities: USER_CAPABILITIES,
};

const app = { name: "widget-app", cwd: "/nowhere", port: 1 } as AppRecord;

function ctx(): RouteHandlerContext {
  return {
    identity,
    params: { name: app.name },
    body: undefined,
    rawBody: "",
    query: new URLSearchParams({ registration: "7" }),
    req: new Request("http://localhost/"),
  };
}

it("starts the serving probe before the files revision answers", async () => {
  const started: string[] = [];
  let answerRevision!: (value: string) => void;
  let answerServing!: (value: boolean) => void;
  const handlers = appWidgetHandlers({
    get: (name) => (name === app.name ? app : null),
    registration: () => 7,
    canAccess: () => true,
    appUrl: () => "https://widget-app.office.test/",
    sessionExpiresAt: () => null,
    chat: () => null,
    metadata: () => Promise.reject(new Error("not read by apps.widget")),
    revision: () => {
      started.push("revision");
      return new Promise((res) => (answerRevision = res));
    },
    serving: () => {
      started.push("serving");
      return new Promise((res) => (answerServing = res));
    },
  });
  const pending = Promise.resolve(handlers["apps.widget"](ctx()));
  // Let every step the handler can take without an answer run.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(started.sort()).toEqual(["revision", "serving"]);
  answerServing(true);
  answerRevision("0:3:1234");
  const res = await pending;
  expect(res).toMatchObject({
    kind: "json",
    body: { revision: "0:3:1234", serving: true },
  });
});
