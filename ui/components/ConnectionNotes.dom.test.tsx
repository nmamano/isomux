// Usage notes for agents (integrations A4): edited where a connection is set
// and shown on its row of the integrations list.

import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { ConnectionsList } = await import("./ConnectionsList.tsx");
const { ManagedEnvEditor } = await import("./ManagedEnvEditor.tsx");
const { McpServersList } = await import("./McpServersList.tsx");
const { setApiShim } = await import("../api.ts");
const { demoSecretsRoute } = await import("../demo-secrets.ts");
const { demoMcpServersRoute } = await import("../demo-mcp-servers.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
afterAll(() => setApiShim(null));

const { t } = translatorFor("en");

type List = import("../../shared/contract-shapes").ConnectionsListRes;

it("shows a note under its variable, secret and MCP server row, and none where there is none", async () => {
  const list: List = {
    variables: [
      { scope: "personal", name: "WITH_NOTE", note: "acme org only" },
      { scope: "personal", name: "NO_NOTE", note: null },
    ],
    signIns: [],
    claudeConnectors: [],
    mcpServers: [
      {
        scope: "office",
        name: "linear",
        host: "mcp.linear.app",
        credential: false,
        secret: null,
        problem: null,
        overridden: false,
        note: "ops team issues",
      },
    ],
    engineMcpServers: [],
    secrets: [
      {
        scope: "personal",
        name: "GH",
        hosts: ["api.github.com"],
        test: null,
        // Note text is text, never markup.
        note: '<img src=x onerror="boom">\nline two',
      },
    ],
  };
  setApiShim(async () => list);
  const view = render(
    <ConnectionsList username="Ann" half="office" canTestOffice />,
  );
  await act(async () => {});
  const notes = Object.fromEntries(
    [
      ...view.container.querySelectorAll<HTMLElement>("[data-connection-row]"),
    ].map((row) => [
      row.querySelector("[data-connection-name]")?.textContent ?? "",
      row.querySelector("[data-connection-note]")?.textContent ?? null,
    ]),
  );
  expect(notes).toMatchObject({
    WITH_NOTE: "acme org only",
    NO_NOTE: null,
    GH: '<img src=x onerror="boom">\nline two',
  });
  expect(
    Object.entries(notes).find(([name]) => name.includes("linear"))?.[1],
  ).toBe("ops team issues");
  expect(view.container.querySelector("img")).toBeNull();
  view.unmount();
});

it("loads, edits and saves a variable's note with the variables", async () => {
  const puts: unknown[] = [];
  setApiShim(async (method, _path, body) => {
    if (method === "GET")
      return {
        mode: "managed",
        values: { A: "1", B: "2" },
        notes: { A: "first line\nsecond line" },
      };
    puts.push(body);
    return undefined;
  });
  const view = render(<ManagedEnvEditor path="/api/users/ann/env" />);
  await act(async () => {});
  const notes = view.getAllByLabelText(
    t("settings.connections.note"),
  ) as HTMLTextAreaElement[];
  // The note keeps its newline, so saving another row does not change it.
  expect(notes.map((note) => note.value)).toEqual([
    "first line\nsecond line",
    "",
  ]);
  const save = () => view.getByRole("button", { name: t("settings.env.save") });
  expect(
    view.queryByRole("button", { name: t("settings.env.save") }),
  ).toBeNull();
  fireEvent.change(notes[1], { target: { value: " use for B " } });
  await act(async () => fireEvent.click(save()));
  expect(puts).toEqual([
    {
      values: { A: "1", B: "2" },
      notes: { A: "first line\nsecond line", B: "use for B" },
    },
  ]);
  view.unmount();
});

it("edits an MCP server's note and clears it", async () => {
  const calls: { method: string; body: unknown }[] = [];
  setApiShim(async (method, path, body) => {
    calls.push({ method, body });
    const answer =
      demoSecretsRoute(method, path, body, () => "u-notes") ??
      demoMcpServersRoute(method, path, body, () => "u-notes");
    if (!answer) throw new Error(`unexpected ${method} ${path}`);
    return answer.result;
  });
  const path = "/api/users/ann/mcp-servers";
  const view = render(
    <McpServersList path={path} secretsPath="/api/users/ann/secrets" canEdit />,
  );
  await act(async () => {});
  fireEvent.click(
    view.getByRole("button", { name: t("settings.mcpServers.add") }),
  );
  fireEvent.change(view.getByLabelText(t("settings.mcpServers.name")), {
    target: { value: "docs" },
  });
  fireEvent.change(view.getByLabelText(t("settings.mcpServers.url")), {
    target: { value: "https://docs.example.com/mcp" },
  });
  fireEvent.change(view.getByLabelText(t("settings.connections.note")), {
    target: { value: "read only" },
  });
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: t("common.save") })),
  );
  expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
    name: "docs",
    note: "read only",
  });
  fireEvent.click(
    view.getByRole("button", { name: t("settings.secrets.edit") }),
  );
  const note = view.getByLabelText(
    t("settings.connections.note"),
  ) as HTMLTextAreaElement;
  expect(note.value).toBe("read only");
  fireEvent.change(note, { target: { value: "" } });
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: t("common.save") })),
  );
  expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
    note: "",
  });
  view.unmount();
});
