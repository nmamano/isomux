import { describe, expect, it } from "bun:test";
import {
  APPS_NOT_SUPPORTED_MESSAGE,
  appHostingUnsupportedReason,
  createUnavailableAppSupervisor,
} from "./app-hosting.ts";
import { AppSupervisorError } from "./app-supervisor.ts";
import {
  appHostingClaudeCaveatTail,
  appHostingSection,
} from "./system-prompt.ts";
import type { AppRecord } from "../shared/types.ts";

const record = { name: "hello" } as AppRecord;

describe("app hosting on a host without systemd", () => {
  it("is off everywhere but Linux", () => {
    expect(appHostingUnsupportedReason("linux")).toBeNull();
    for (const platform of ["darwin", "win32", "freebsd"] as const)
      expect(appHostingUnsupportedReason(platform)).toBe(
        APPS_NOT_SUPPORTED_MESSAGE,
      );
  });

  it("reports nothing installed or running and refuses to run anything", () => {
    const supervisor = createUnavailableAppSupervisor();
    expect(supervisor.states(["hello"]).size).toBe(0);
    expect(supervisor.readToken("hello")).toBeNull();
    expect(supervisor.readUnitFile("hello")).toBeNull();
    expect(supervisor.unitInjectsToken("hello")).toBe(false);
    expect(() => supervisor.teardown("hello")).not.toThrow();
    const refusals: Array<() => unknown> = [
      () => supervisor.install(record),
      () => supervisor.reinstall(record),
      () => supervisor.regenerate(record),
      () => supervisor.provisionToken("hello", "token"),
      () => supervisor.start("hello"),
      () => supervisor.stop("hello"),
      () => supervisor.restart("hello"),
      () => supervisor.logs("hello", 10),
      () => supervisor.reloadUnits(),
      () => supervisor.restoreUnitFile("hello", "unit"),
    ];
    for (const refusal of refusals) {
      let caught: unknown;
      try {
        refusal();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AppSupervisorError);
      expect((caught as AppSupervisorError).code).toBe("apps_not_supported");
    }
  });

  it("points agents at the apps topic only where apps can run", () => {
    expect(appHostingSection(null)).toContain("`apps`");
    const off = appHostingSection(APPS_NOT_SUPPORTED_MESSAGE);
    expect(off).toContain(APPS_NOT_SUPPORTED_MESSAGE);
    expect(off).not.toContain("`apps`");
  });

  it("points the Claude caveat at the app section only where apps can run", () => {
    expect(appHostingClaudeCaveatTail(null)).not.toBe("");
    expect(appHostingClaudeCaveatTail(APPS_NOT_SUPPORTED_MESSAGE)).toBe("");
  });
});
