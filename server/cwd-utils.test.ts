import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { inspectCodexStoredSession } from "./cwd-utils.ts";

const THREAD_ID = "019a7b3c-1111-7222-8333-123456789abc";
const roots: string[] = [];

function codexHome(contents?: string): string {
  const root = mkdtempSync(join(tmpdir(), "isomux-codex-inspect-"));
  roots.push(root);
  if (contents !== undefined) {
    const sessions = join(root, "sessions", "2026", "08", "28");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, `rollout-test-${THREAD_ID}.jsonl`), contents);
  }
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("inspectCodexStoredSession", () => {
  it("distinguishes missing, header-only, and durable rollouts", () => {
    expect(
      inspectCodexStoredSession(THREAD_ID, { CODEX_HOME: codexHome() }),
    ).toBe("missing");
    expect(
      inspectCodexStoredSession(THREAD_ID, {
        CODEX_HOME: codexHome('{"type":"session_meta"}\n'),
      }),
    ).toBe("empty");
    expect(
      inspectCodexStoredSession(THREAD_ID, {
        CODEX_HOME: codexHome(
          '{"type":"session_meta"}\n{"type":"response_item"}\n',
        ),
      }),
    ).toBe("durable");
  });

  it("keeps the existing assume-durable rule for an unreadable tail", () => {
    expect(
      inspectCodexStoredSession(THREAD_ID, {
        CODEX_HOME: codexHome('{"type":"session_meta"}\n{"partial"'),
      }),
    ).toBe("durable");
  });
});
