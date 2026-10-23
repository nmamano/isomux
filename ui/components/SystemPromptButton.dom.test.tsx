import { describe, expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render, fireEvent, waitFor } =
  await import("@testing-library/react");
const { setApiShim } = await import("../api.ts");
const { SystemPromptButton } = await import("./SystemPromptButton.tsx");
const { isExpandedEditorOpen } = await import("./ExpandableTextarea.tsx");
const { LogEntryCard } = await import("../log-view/LogEntryCard.tsx");
const { en } = await import("../../shared/i18n/en.ts");

describe("SystemPromptButton", () => {
  it("opens the fetched prompt in a read-only modal and copies it", async () => {
    const calls: string[] = [];
    setApiShim(async (method, path) => {
      calls.push(`${method} ${path}`);
      return { prompt: "Prompt body\nSecond line" };
    });
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void (copied = text) },
    });
    const view = render(<SystemPromptButton agentId="agent-1" />);
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", {
          name: en["dialogs.agent.showSystemPrompt"],
        }),
      );
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(view.getByText("Prompt body", { exact: false })).toBeTruthy(),
    );
    expect(calls).toEqual(["GET /api/agents/agent-1/system-prompt"]);
    expect(view.getByRole("dialog").getAttribute("aria-label")).toBe(
      en["dialogs.agent.systemPromptTitle"],
    );
    expect(
      view
        .getByText("Prompt body", { exact: false })
        .getAttribute("aria-readonly"),
    ).toBe("true");
    jest.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: en["common.copy"] }));
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(copied).toBe("Prompt body\nSecond line");
        expect(
          view.getByRole("button", { name: en["common.copiedNotice"] }),
        ).toBeTruthy();
      });
      // The copied notice gives the button back after a moment.
      await act(async () => jest.advanceTimersByTime(1600));
      expect(
        view.getByRole("button", { name: en["common.copy"] }),
      ).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
    view.unmount();
  });

  it("opens and copies both cronjob prompt sources", async () => {
    const calls: string[] = [];
    setApiShim(async (method, path) => {
      calls.push(`${method} ${path}`);
      return {
        systemPrompt: "Cronjob system prompt",
        firstUserMessage: "Configured request",
      };
    });
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void (copied = text) },
    });
    const view = render(<SystemPromptButton cronjobId="cron-1" />);
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", {
          name: en["dialogs.agent.showCronjobPrompt"],
        }),
      );
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        view.getByText("Configured request", { exact: false }),
      ).toBeTruthy(),
    );
    expect(calls).toEqual(["GET /api/cronjobs/cron-1/system-prompt"]);
    expect(view.getByRole("dialog").getAttribute("aria-label")).toBe(
      en["dialogs.agent.cronjobPromptTitle"],
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: en["common.copy"] }));
      await Promise.resolve();
    });
    const heading = en["commands.isomuxCronjobSystemPrompt.firstUserMessage"];
    expect(copied).toBe(
      `Cronjob system prompt\n\n----\n${heading}\n\nConfigured request`,
    );
    view.unmount();
  });

  it("shows load errors and closes from the Close button", async () => {
    setApiShim(async () => {
      throw new Error("offline");
    });
    const view = render(<SystemPromptButton agentId="agent-1" />);
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", {
          name: en["dialogs.agent.showSystemPrompt"],
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        view.getByText(en["dialogs.agent.systemPromptLoadFailed"]),
      ).toBeTruthy(),
    );
    expect(
      view
        .getByRole("button", { name: en["common.copy"] })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(view.getByRole("button", { name: en["common.close"] }));
    expect(view.queryByRole("dialog") === null).toBe(true);
    view.unmount();
  });

  it("claims Escape and closes only the prompt modal", async () => {
    setApiShim(async () => ({ prompt: "Prompt body" }));
    const view = render(<SystemPromptButton agentId="agent-1" />);
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", {
          name: en["dialogs.agent.showSystemPrompt"],
        }),
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByRole("dialog")).toBeTruthy());
    expect(isExpandedEditorOpen()).toBe(true);
    // A host's own Escape handler (bubbling) never sees the key.
    const hostKeys: string[] = [];
    const hostListener = (event: KeyboardEvent) => hostKeys.push(event.key);
    window.addEventListener("keydown", hostListener);
    try {
      fireEvent.keyDown(document.body, { key: "Escape", bubbles: true });
    } finally {
      window.removeEventListener("keydown", hostListener);
    }
    expect(view.queryByRole("dialog") === null).toBe(true);
    expect(hostKeys).toEqual([]);
    expect(isExpandedEditorOpen()).toBe(false);
    expect(
      view.getByRole("button", { name: en["dialogs.agent.showSystemPrompt"] }),
    ).toBeTruthy();
    view.unmount();
  });
});

describe("system-prompt log marker", () => {
  it("renders a short help card that opens its stored modal payload", () => {
    const calls: string[] = [];
    setApiShim(async (method, path) => {
      calls.push(`${method} ${path}`);
      return {};
    });
    const view = render(
      <LogEntryCard
        entry={{
          id: "entry-help",
          agentId: "agent-1",
          timestamp: 1,
          kind: "system",
          content: "Help",
          metadata: { helpContent: "## Commands\n/help" },
        }}
      />,
    );
    fireEvent.click(
      view.getByRole("button", { name: en["dialogs.agent.showHelp"] }),
    );
    // The payload rides in the log entry: no API request.
    expect(calls).toEqual([]);
    expect(view.getByRole("dialog").querySelector("h2")?.textContent).toBe(
      "Commands",
    );
    expect(
      view.getByRole("dialog").querySelector('[aria-readonly="true"]'),
    ).not.toBe(null);
    view.unmount();
  });

  it("opens each marker's prompt from its own source", async () => {
    const calls: string[] = [];
    setApiShim(async (method, path) => {
      calls.push(`${method} ${path}`);
      return path.startsWith("/api/cronjobs/")
        ? { systemPrompt: "Cronjob system prompt", firstUserMessage: "Ask" }
        : { prompt: "Agent prompt" };
    });
    const view = render(
      <>
        <LogEntryCard
          entry={{
            id: "entry-1",
            agentId: "agent-1",
            timestamp: 1,
            kind: "system",
            content: "Agent marker",
            metadata: { systemPrompt: true },
          }}
        />
        <LogEntryCard
          entry={{
            id: "entry-cron",
            agentId: "agent-1",
            timestamp: 1,
            kind: "system",
            content: 'Cronjob prompt for "Night report"',
            metadata: { systemPrompt: true, cronjobId: "cron-1" },
          }}
        />
      </>,
    );
    expect(view.getByText("Agent marker")).toBeTruthy();
    expect(view.getByText('Cronjob prompt for "Night report"')).toBeTruthy();
    for (const [name, text] of [
      ["dialogs.agent.showSystemPrompt", "Agent prompt"],
      ["dialogs.agent.showCronjobPrompt", "Cronjob system prompt"],
    ] as const) {
      fireEvent.click(view.getByRole("button", { name: en[name] }));
      await waitFor(() =>
        expect(view.getByText(text, { exact: false })).toBeTruthy(),
      );
      fireEvent.click(view.getByRole("button", { name: en["common.close"] }));
    }
    expect(calls).toEqual([
      "GET /api/agents/agent-1/system-prompt",
      "GET /api/cronjobs/cron-1/system-prompt",
    ]);
    view.unmount();
  });

  it("renders the header's bold and italic markup instead of its asterisks", async () => {
    const view = render(
      <LogEntryCard
        entry={{
          id: "entry-2",
          agentId: "agent-1",
          timestamp: 1,
          kind: "system",
          content:
            "**Full system prompt** *(reflects current settings; takes effect on next conversation)*",
          metadata: { systemPrompt: true },
        }}
      />,
    );
    expect(view.container.textContent).not.toContain("*");
    expect(view.container.querySelector("strong")?.textContent).toBe(
      "Full system prompt",
    );
    expect(view.container.querySelector("em")?.textContent).toBe(
      "(reflects current settings; takes effect on next conversation)",
    );
    view.unmount();
    setApiShim(null);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});
