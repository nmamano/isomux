import { describe, expect, test } from "bun:test";
import { SshClient, classifyAuth, sshBaseArgs, type SshTarget } from "./ssh.ts";

const target: SshTarget = {
  host: "box.example",
  user: "root",
  identityFile: "/run/key",
  knownHostsFile: "/run/known_hosts",
};

describe("the flags the revocation proof depends on", () => {
  const args = sshBaseArgs(target, "yes");

  // If ssh could satisfy the post-revocation reconnect from the operator's own
  // ~/.ssh, from a forwarded agent, or from a Host stanza, the proof would pass
  // for the wrong reason - and it is the one assertion the zero-standing-access
  // guarantee rests on.
  test("no user config, no agent, only the identity we name", async () => {
    expect(args).toContain("-F");
    expect(args).toContain("/dev/null");
    expect(args).toContain("IdentitiesOnly=yes");
    expect(args).toContain("IdentityAgent=none");
    expect(args).toContain("PreferredAuthentications=publickey");
    expect(args).toContain("BatchMode=yes");
  });

  test("the host key is pinned to our own known_hosts", async () => {
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain(`UserKnownHostsFile=${target.knownHostsFile}`);
  });

  test("first contact is the only place accept-new is allowed", async () => {
    expect(sshBaseArgs(target, "accept-new")).toContain(
      "StrictHostKeyChecking=accept-new",
    );
  });
});

describe("classifyAuth", () => {
  test("exit 0 is authentication", async () => {
    expect(classifyAuth({ code: 0, stdout: "", stderr: "" })).toEqual({
      kind: "authenticated",
    });
  });

  test("a publickey refusal is the ONLY proof of absence or expiry", async () => {
    expect(
      classifyAuth({
        code: 255,
        stdout: "",
        stderr: "root@box: Permission denied (publickey).",
      }),
    ).toEqual({ kind: "rejected" });
  });

  // Each of these would let a network problem certify the guarantee.
  test.each([
    [
      "ssh: connect to host box port 22: Connection timed out",
      "connection timed out",
    ],
    [
      "ssh: connect to host box port 22: Connection refused",
      "transport failure",
    ],
    [
      "ssh: Could not resolve hostname box: Name or service not known",
      "name resolution failed",
    ],
    [
      "@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@",
      "host key mismatch",
    ],
    ["Host key verification failed.", "host key mismatch"],
  ])("%s is inconclusive, never proof", (stderr, reason) => {
    const out = classifyAuth({ code: 255, stdout: "", stderr });
    expect(out.kind).toBe("inconclusive");
    if (out.kind === "inconclusive") expect(out.reason).toBe(reason);
  });

  test("an unrecognised ssh failure is inconclusive, not proof", async () => {
    const out = classifyAuth({
      code: 255,
      stdout: "",
      stderr: "something new",
    });
    expect(out.kind).toBe("inconclusive");
  });

  test("a remote command failing on its own terms still means we got in", async () => {
    // ssh reserves 255 for its own errors; anything else came from the far end,
    // which can only happen after authentication succeeded.
    expect(
      classifyAuth({ code: 1, stdout: "", stderr: "no such file" }),
    ).toEqual({
      kind: "authenticated",
    });
  });
});

// Found live on 2026-08-09: an authorized_keys line passed as ONE token became
// three arguments on the far side and wrote a corrupt key, which produced a
// test that passed while proving nothing. The constraint is now enforced.
describe("pipe rejects arguments the remote shell would re-split", () => {
  const exec = {
    calls: [] as string[][],
    run(argv: string[]) {
      this.calls.push(argv);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  };

  test("a public key line is refused, because it carries spaces", async () => {
    const client = new SshClient(target, exec);
    let message = "";
    try {
      await client.pipe(
        ["bash", "-s", "--", "ssh-ed25519 AAAAC3Nza key-comment"],
        "true\n",
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/would be re-split/);
  });

  test.each([["a;rm -rf /"], ["$(whoami)"], ["a b"], ["`id`"], ["a|b"]])(
    "refuses %s",
    async (token) => {
      const client = new SshClient(target, exec);
      let threw = false;
      try {
        await client.pipe(["bash", token], "true\n");
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    },
  );

  test("ordinary tokens - paths, flags, base64 blobs, our instants - pass", async () => {
    const client = new SshClient(target, exec);
    const res = await client.pipe(
      [
        "sudo",
        "-n",
        "bash",
        "-s",
        "--",
        "/root/.ssh/authorized_keys",
        "20260809135227Z",
        "ssh-ed25519",
        "AAAAC3NzaC1lZDI1NTE5AAAAI+/=",
      ],
      "true\n",
    );
    expect(res.code).toBe(0);
  });
});
