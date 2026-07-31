// Phase 3a - route matcher contract. Pins longest-static-wins and param
// extraction over the REAL typed table (server/routes/table.ts), including the
// collisions Reviewer1 called out. Zero LLM, no server boot.

import { describe, it, expect } from "bun:test";
import { matchRoute } from "../routes/match.ts";
import { API_ROUTES } from "../routes/table.ts";

function m(method: string, path: string) {
  return matchRoute(API_ROUTES, method, path);
}

describe("routes/match: basic resolution + params", () => {
  it("resolves a static GET route", () => {
    const r = m("GET", "/api/tasks");
    expect(r?.route.opId).toBe("tasks.list");
    expect(r?.params).toEqual({});
  });

  it("extracts a single :param", () => {
    const r = m("GET", "/api/cronjobs/j1");
    expect(r?.route.opId).toBe("cron.get");
    expect(r?.params).toEqual({ id: "j1" });
  });

  it("extracts nested :params", () => {
    const r = m("POST", "/api/cronjobs/j1/runs/r1/read-file");
    expect(r?.route.opId).toBe("cron.runReadFile");
    expect(r?.params).toEqual({ id: "j1", runId: "r1" });
  });

  it("decodes percent-encoded params", () => {
    const r = m("GET", "/api/agents/a1/files/my%20file.png");
    expect(r?.route.opId).toBe("agents.getFile");
    expect(r?.params).toEqual({ id: "a1", filename: "my file.png" });
  });

  it("ignores a trailing slash", () => {
    expect(m("GET", "/api/tasks/")?.route.opId).toBe("tasks.list");
  });
});

describe("routes/match: longest-static-wins", () => {
  it("DELETE /api/sessions/current -> sessions.logout (static beats :sessionPrefix)", () => {
    const r = m("DELETE", "/api/sessions/current");
    expect(r?.route.opId).toBe("sessions.logout");
    expect(r?.params).toEqual({});
  });

  it("DELETE /api/sessions/<prefix> -> sessions.revoke (the param route)", () => {
    const r = m("DELETE", "/api/sessions/abc123");
    expect(r?.route.opId).toBe("sessions.revoke");
    expect(r?.params).toEqual({ sessionPrefix: "abc123" });
  });

  it("GET /api/agents/:id/file vs /files/:filename disambiguate by arity", () => {
    expect(m("GET", "/api/agents/a1/file")?.route.opId).toBe("agents.openFile");
    expect(m("GET", "/api/agents/a1/files/x.png")?.route.opId).toBe(
      "agents.getFile",
    );
  });

  it("the off-:id paths /api/cron-runs and /api/cron-prompt don't shadow /api/cronjobs/:id", () => {
    expect(m("GET", "/api/cron-runs")?.route.opId).toBe("cron.listAllRuns");
    expect(m("PUT", "/api/cron-prompt")?.route.opId).toBe("cron.setPrompt");
    expect(m("GET", "/api/cronjobs/cron-runs")?.route.opId).toBe("cron.get");
  });
});

describe("routes/match: misses", () => {
  it("returns null for an unknown path", () => {
    expect(m("GET", "/api/does-not-exist")).toBeNull();
  });

  it("returns null for a method mismatch", () => {
    expect(m("PUT", "/api/tasks")).toBeNull();
  });

  it("returns null for a legacy (non-/api) path not in the table", () => {
    expect(m("GET", "/tasks")).toBeNull();
    expect(m("POST", "/agents/a1/read-file")).toBeNull();
  });
});
