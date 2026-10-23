import { expectRejection } from "../../test-support/expect-rejection.ts";
import { expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { STATE_ROOT } from "../../config.ts";
import { claudeProjectDir } from "../../cwd-utils.ts";
import { claudeSessionStore } from "./session-store.ts";
import { LocalizedError } from "../../localized-error.ts";

it("the real SDK reads and authors the fork only through the pinned store", async () => {
  const root = mkdtempSync(join(STATE_ROOT, "store-"));
  const old = join(root, "old"),
    current = join(root, "current"),
    cwd = join(root, "cwd");
  const sessionId = crypto.randomUUID(),
    uuid = crypto.randomUUID();
  const oldProject = claudeProjectDir(cwd, { CLAUDE_CONFIG_DIR: old });
  const newProject = claudeProjectDir(cwd, { CLAUDE_CONFIG_DIR: current });
  mkdirSync(oldProject, { recursive: true });
  mkdirSync(newProject, { recursive: true });
  writeFileSync(
    join(oldProject, `${sessionId}.jsonl`),
    JSON.stringify({
      type: "user",
      uuid,
      parentUuid: null,
      sessionId,
      isSidechain: false,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "stored in old root" },
    }) + "\n",
  );
  const source = `
    import {getSessionMessages, forkSession} from ${JSON.stringify(resolve("node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"))};
    import {claudeSessionStore} from ${JSON.stringify(join(import.meta.dir, "session-store.ts"))};
    const sid=${JSON.stringify(sessionId)}, cwd=${JSON.stringify(cwd)};
    const adapter=claudeSessionStore(sid,cwd,{CLAUDE_CONFIG_DIR:${JSON.stringify(old)}});
    let loads=0, appends=0;
    const store={load:async key=>{loads++;return adapter.load(key)},append:async(key,entries)=>{appends++;return adapter.append(key,entries)}};
    const messages=await getSessionMessages(sid,{dir:cwd,sessionStore:store});
    const fork=await forkSession(sid,{dir:cwd,sessionStore:store,upToMessageId:${JSON.stringify(uuid)}});
    console.log(JSON.stringify({loads,appends,messages:messages.length,fork:fork.sessionId}));
  `;
  const child = Bun.spawn([process.execPath, "--eval", source], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: current },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  const result = JSON.parse(output);
  expect(result.loads).toBe(2);
  expect(result.appends).toBe(1);
  expect(result.messages).toBe(1);
  expect(existsSync(join(oldProject, `${result.fork}.jsonl`))).toBe(true);
  expect(existsSync(join(newProject, `${result.fork}.jsonl`))).toBe(false);
  const forkStore = claudeSessionStore(result.fork, cwd, {
    CLAUDE_CONFIG_DIR: old,
  });
  expect(
    (await forkStore.load({ projectKey: cwd, sessionId: result.fork }))?.length,
  ).toBeGreaterThan(0);
});

// Confinement: the store serves only its own session, never a subpath, and
// authors only a new fork under a UUID (a path as session id is refused).
it("rejects unrelated reads, subpaths, paths and overwrites", async () => {
  const root = mkdtempSync(join(STATE_ROOT, "store-reject-"));
  const sid = crypto.randomUUID(),
    fork = crypto.randomUUID();
  const dir = claudeProjectDir(root, { CLAUDE_CONFIG_DIR: root });
  mkdirSync(dir, { recursive: true });
  const store = claudeSessionStore(sid, root, { CLAUDE_CONFIG_DIR: root });
  const refused = async (attempt: Promise<unknown>) => {
    const error = await attempt.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LocalizedError);
    expect((error as LocalizedError).logMessage.key).toBe(
      "systemEntries.claudeSession.invalid",
    );
  };
  await refused(store.load({ projectKey: root, sessionId: fork }));
  await refused(
    store.load({
      projectKey: root,
      sessionId: sid,
      subpath: "subagents/foreign",
    }),
  );
  await refused(store.append({ projectKey: root, sessionId: sid }, []));
  await refused(store.append({ projectKey: root, sessionId: "../x" }, []));
  await store.append({ projectKey: root, sessionId: fork }, []);
  await expectRejection(
    store.append({ projectKey: root, sessionId: fork }, []),
    /EEXIST/,
  );
});
