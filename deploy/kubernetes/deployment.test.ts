import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { dirname } from "path";

// Owner recovery on EKS (internal-docs/owner-login-recovery-design.md, Option
// 1b): the admin socket refuses the office uid, so a second container with its
// own uid reaches it through a shared emptyDir.

type Container = {
  name: string;
  command?: string[];
  args?: string[];
  env?: { name: string; value?: string }[];
  securityContext?: { runAsUser?: number };
  volumeMounts: { name: string; mountPath: string }[];
};
const template = (
  Bun.YAML.parse(
    readFileSync(new URL("./deployment.yaml", import.meta.url), "utf8"),
  ) as {
    spec: {
      template: {
        metadata: { annotations?: Record<string, string> };
        spec: {
          securityContext: { runAsUser: number };
          containers: Container[];
          volumes: { name: string; emptyDir?: object }[];
        };
      };
    };
  }
).spec.template;
const pod = template.spec;
const office = pod.containers.find((c) => c.name === "office")!;
const recovery = pod.containers.find((c) => c.name === "recovery")!;
const envOf = (container: Container, name: string) =>
  container.env?.find((e) => e.name === name)?.value;
const env = (name: string) => envOf(office, name);

test("kubectl exec and logs still default to the office container", () => {
  expect(
    template.metadata.annotations?.["kubectl.kubernetes.io/default-container"],
  ).toBe("office");
});

test("the recovery container replaces the image entrypoint", () => {
  expect(recovery.command?.length).toBeGreaterThan(0);
  expect(recovery.args).toBeUndefined();
});

test("the office answers the recovery uid, which is not its own", () => {
  const recoveryUid = recovery.securityContext?.runAsUser;
  expect(recoveryUid).toBeDefined();
  expect(recoveryUid).not.toBe(pod.securityContext.runAsUser);
  expect(env("ISOMUX_RECOVERY_UID")).toBe(String(recoveryUid));
});

test("both containers mount the socket directory from an emptyDir", () => {
  expect(env("ISOMUX_ADMIN_SOCKET")).toBeDefined();
  expect(envOf(recovery, "ISOMUX_ADMIN_SOCKET")).toBe(
    env("ISOMUX_ADMIN_SOCKET"),
  );
  const socketDir = dirname(env("ISOMUX_ADMIN_SOCKET") ?? "");
  const officeMount = office.volumeMounts.find(
    (m) => m.mountPath === socketDir,
  );
  expect(officeMount).toBeDefined();
  expect(recovery.volumeMounts).toContainEqual(officeMount!);
  expect(
    pod.volumes.find((v) => v.name === officeMount!.name)?.emptyDir,
  ).toBeDefined();
});
