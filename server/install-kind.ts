import { readFileSync } from "fs";

export const INSTALL_KIND_FILE = "/etc/isomux/install-kind";

export type InstallKind = "hosted" | "self-hosted";

// The marker is root-written during a hosted install. Every failure and every
// value except the exact hosted line is the backward-compatible self-hosted
// case. Never expose marker bytes to a prompt.
export function readInstallKind(path = INSTALL_KIND_FILE): InstallKind {
  try {
    const value = readFileSync(path, "utf8").replace(/\r?\n$/, "");
    return value === "hosted" ? "hosted" : "self-hosted";
  } catch {
    return "self-hosted";
  }
}

export const INSTALL_KIND = readInstallKind();
