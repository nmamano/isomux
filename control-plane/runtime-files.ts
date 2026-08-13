import * as path from "node:path";

/** Repository files that the running provisioner reads as payloads. */
export const RUNTIME_REPO_FILES = {
  authorizedKeys: "control-plane/remote/authorized-keys.sh",
  cleanup: "control-plane/cleanup.sh",
  installCustomerKey: "control-plane/remote/install-customer-key.sh",
  installer: "deploy/install.sh",
  mintInvite: "control-plane/remote/mint-invite.sh",
  revokeKey: "control-plane/remote/revoke-key.sh",
  rewriteKey: "control-plane/remote/rewrite-key.sh",
  waitApt: "control-plane/remote/wait-apt.sh",
  wrapper: "control-plane/wrapper.sh",
} as const;

export type RuntimeRepoFile = keyof typeof RUNTIME_REPO_FILES;

/** Resolve a runtime payload from the repository or deployed `/app` root. */
export function runtimeRepoFile(
  name: RuntimeRepoFile,
  root: string = path.join(import.meta.dir, ".."),
): string {
  return path.join(root, RUNTIME_REPO_FILES[name]);
}
