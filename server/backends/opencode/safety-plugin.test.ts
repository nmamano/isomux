import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { STATE_ROOT } from "../../config.ts";
import { evaluateOpenCodePermission } from "./safety-adapter.ts";
import { buildOpenCodeSafetyPlugin } from "./safety-plugin-build.ts";
import safetyPlugin, { openCodeToolAction } from "./safety-plugin.ts";

type Hooks = {
  "tool.execute.before": (
    input: { tool: string },
    output: { args: unknown },
  ) => Promise<void>;
};

async function verdict(hooks: Hooks, tool: string, args: unknown) {
  return hooks["tool.execute.before"]({ tool }, { args }).then(
    () => "allow",
    (error: Error) => error.message,
  );
}

describe("openCodeToolAction", () => {
  it("runs bash in its workdir, resolved against the folder", () => {
    expect(openCodeToolAction("bash", { command: "ls" }, "/repo")).toEqual({
      action: { kind: "shell", command: "ls" },
      cwd: "/repo",
    });
    expect(
      openCodeToolAction("bash", { command: "ls", workdir: "sub" }, "/repo")
        ?.cwd,
    ).toBe("/repo/sub");
    expect(
      openCodeToolAction("bash", { command: "ls", workdir: "/tmp" }, "/repo")
        ?.cwd,
    ).toBe("/tmp");
  });

  it("maps file tools to the policy's file actions", () => {
    expect(
      openCodeToolAction("read", { filePath: "/repo/a" }, "/repo")?.action.kind,
    ).toBe("read-files");
    expect(
      openCodeToolAction("grep", { pattern: "x", include: "*.pem" }, "/repo")
        ?.action,
    ).toEqual({
      kind: "read-files",
      toolName: "Grep",
      input: { path: undefined, glob: "*.pem" },
    });
    for (const tool of ["edit", "write"])
      expect(
        openCodeToolAction(tool, { filePath: "/repo/a" }, "/repo")?.action.kind,
      ).toBe("write-files");
    expect(
      openCodeToolAction("apply_patch", { patchText: "p" }, "/repo")?.action,
    ).toEqual({ kind: "patch-files", toolName: "apply_patch", patch: "p" });
  });
});

// The plugin and the permission-ask path (safety-adapter.ts) decide each call
// alike: one policy, two ways in.
describe("the safety plugin and the ask path", () => {
  const repo = "/srv/b1045-repo";
  const commands = ["git reset --hard", "ls -la", "rm -rf ~", "cat .env"];
  const files = [
    join(repo, "src", "a.ts"),
    join(STATE_ROOT, "agents.json"),
    join(repo, ".env"),
  ];
  const cases = [
    ...commands.map((command) => ({
      tool: "bash",
      args: { command },
      ask: { permission: "bash", metadata: { command } },
    })),
    ...files.flatMap((filePath) =>
      ["edit", "write"].map((tool) => ({
        tool,
        args: { filePath, content: "" },
        ask: { permission: "edit", metadata: { filepath: filePath } },
      })),
    ),
    // A tool the policy does not check runs on both paths.
    {
      tool: "webfetch",
      args: { url: "https://example.com" },
      ask: { permission: "webfetch", metadata: {} },
    },
  ];
  for (const { tool, args, ask } of cases) {
    // The state root is a temp folder per run: keep it out of the name.
    const label = JSON.stringify(args).replaceAll(STATE_ROOT, "<state root>");
    it(`agree on ${tool} ${label}`, async () => {
      const hooks = await safetyPlugin.server({ directory: repo });
      const asked = evaluateOpenCodePermission(
        { id: "p", sessionId: "s", patterns: [], ...ask },
        repo,
      );
      expect(asked.kind).toBe("policy");
      const expected =
        asked.kind === "policy" && asked.decision.decision === "deny"
          ? asked.decision.reason
          : "allow";
      expect(await verdict(hooks, tool, args)).toBe(expected);
    });
  }
});

describe("the safety plugin", () => {
  it("bundles into one module with the given roots, not the process's", async () => {
    const home = "/srv/isomux-safety-plugin-home";
    const stateRoot = "/srv/isomux-safety-plugin-state";
    const text = await buildOpenCodeSafetyPlugin({
      home,
      env: {
        ISOMUX_HOME: stateRoot,
        ISOMUX_ADMIN_SOCKET: join(stateRoot, "admin.sock"),
      },
    });
    expect(text, "no import of node:os is left").not.toMatch(
      /from "(node:)?os"/,
    );
    expect(text, "no environment read is left").not.toContain("process.env");
    const dir = await mkdtemp(join(tmpdir(), "isomux-safety-plugin-"));
    const file = join(dir, "plugin.js");
    await writeFile(file, text);
    const bundled = (await import(pathToFileURL(file).href)) as {
      default: typeof safetyPlugin;
    };
    const write = (filePath: string) => ({ filePath, content: "" });
    const hooks = await bundled.default.server({ directory: home });
    const local = await safetyPlugin.server({ directory: home });
    // The state root, and <home>/.isomux reached by a relative path.
    for (const call of [
      write(join(stateRoot, "agents.json")),
      write(".isomux/agents.json"),
    ]) {
      expect(await verdict(hooks, "write", call)).not.toBe("allow");
      expect(
        await verdict(local, "write", call),
        "the process roots differ",
      ).toBe("allow");
    }
  });
});
