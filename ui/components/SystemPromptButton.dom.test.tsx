import { describe, expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render, fireEvent, waitFor } =
  await import("@testing-library/react");
const { setApiShim } = await import("../api.ts");
const { SystemPromptButton } = await import("./SystemPromptButton.tsx");
const { isExpandedEditorOpen } = await import("./ExpandableTextarea.tsx");
const { LogEntryCard } = await import("../log-view/LogEntryCard.tsx");

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
        view.getByRole("button", { name: "Show full system prompt" }),
      );
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(view.getByText("Prompt body", { exact: false }) !== null).toBe(
        true,
      ),
    );
    expect(calls).toEqual(["GET /api/agents/agent-1/system-prompt"]);
    expect(view.getByRole("dialog").getAttribute("aria-label")).toBe(
      "Full system prompt",
    );
    expect(
      view
        .getByText("Prompt body", { exact: false })
        .getAttribute("aria-readonly"),
    ).toBe("true");
    jest.useFakeTimers();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Copy" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(copied).toBe("Prompt body\nSecond line");
      expect(view.getByRole("button", { name: "Copied!" }) !== null).toBe(true);
    });
    await act(async () => jest.advanceTimersByTime(1600));
    jest.useRealTimers();
    expect(
      view.getByRole("dialog").parentElement === document.body.lastElementChild,
    ).toBe(true);
    view.unmount();
  });

  it("shows load errors and closes from the Close button", async () => {
    setApiShim(async () => {
      throw new Error("offline");
    });
    const view = render(<SystemPromptButton agentId="agent-1" />);
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", { name: "Show full system prompt" }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(view.getByText("Could not load the system prompt.") !== null).toBe(
        true,
      ),
    );
    expect(
      view.getByRole("button", { name: "Copy" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    expect(view.queryByRole("dialog") === null).toBe(true);
    view.unmount();
  });

  it("claims Escape and closes only the prompt modal", async () => {
    setApiShim(async () => ({ prompt: "Prompt body" }));
    const view = render(<SystemPromptButton agentId="agent-1" />);
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", { name: "Show full system prompt" }),
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByRole("dialog") !== null).toBe(true));
    expect(isExpandedEditorOpen()).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape", bubbles: true });
    expect(view.queryByRole("dialog") === null).toBe(true);
    expect(isExpandedEditorOpen()).toBe(false);
    expect(
      view.getByRole("button", { name: "Show full system prompt" }) !== null,
    ).toBe(true);
    view.unmount();
  });
});

describe("system-prompt log marker", () => {
  it("renders the short system entry as a prompt button card", async () => {
    const view = render(
      <LogEntryCard
        entry={{
          id: "entry-1",
          agentId: "agent-1",
          timestamp: 1,
          kind: "system",
          content: "Full system prompt",
          metadata: { systemPrompt: true },
        }}
      />,
    );
    expect(view.getByText("Full system prompt") !== null).toBe(true);
    expect(
      view.getByRole("button", { name: "Show full system prompt" }) !== null,
    ).toBe(true);
    view.unmount();
    setApiShim(null);
    await new Promise<void>((resolve) => setImmediate(resolve));
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
