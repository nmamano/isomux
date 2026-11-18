import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { dataChips } from "../test-support/data-values.ts";

setUpDomTestFile();

const { render } = await import("@testing-library/react");
const { LogEntryCard } = await import("./LogEntryCard.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");

// The shape of a settings notice: a header, one line per change.
const CONTENT = "first line\nsecond: a → b\nthird line";

function renderSystem(content: string, metadata?: Record<string, unknown>) {
  return render(
    onLanguage(
      "en",
      <LogEntryCard
        entry={{
          id: "notice",
          agentId: "agent",
          timestamp: 0,
          kind: "system",
          content,
          metadata,
        }}
      />,
    ),
  );
}

// A one-line system entry is the reference for how a system message looks.
function styleOf(view: ReturnType<typeof renderSystem>) {
  const box = view.container.firstElementChild as HTMLElement;
  return {
    textAlign: box.style.textAlign,
    fontStyle: box.style.fontStyle,
    color: box.style.color,
    fontFamily: box.style.fontFamily,
  };
}

it("shows a multi-line isomux notice as a system message, line breaks kept", () => {
  const oneLine = renderSystem("one line");
  const reference = styleOf(oneLine);
  oneLine.unmount();

  const view = renderSystem(CONTENT, { notice: "settings" });
  expect(styleOf(view)).toEqual(reference);
  const box = view.container.firstElementChild as HTMLElement;
  expect(box.style.whiteSpace).toBe("pre-wrap");
  expect(box.textContent).toBe(CONTENT);
  expect(view.container.querySelectorAll("p").length).toBe(0);
  view.unmount();
});

it("keeps unmarked multi-line system output on the Markdown path", () => {
  const view = renderSystem(CONTENT);
  const box = view.container.firstElementChild as HTMLElement;
  expect(box.style.textAlign).toBe("left");
  expect(view.container.querySelectorAll("p").length).toBeGreaterThan(0);
  view.unmount();
});

// A value in a one-line system line looks unlike the words around it, and
// raw backticks never show (task aaf43a3f; AGENTS.md "UI rules"). The value
// style is the Data component's; its marker is how the test finds it.
const { msg, logTextFields } = await import("../../shared/i18n/log-message.ts");
type LogPart = import("../../shared/i18n/log-message.ts").LogPart;
type Lang = import("../../shared/languages.ts").SupportedLanguageCode;

function renderMessage(
  parts: LogPart[],
  options: { language?: Lang; metadata?: Record<string, unknown> } = {},
) {
  const fields = logTextFields(parts);
  expect(fields.message).toBeDefined();
  return render(
    onLanguage(
      options.language ?? "en",
      <LogEntryCard
        entry={{
          id: "line",
          agentId: "agent",
          timestamp: 0,
          kind: "system",
          content: fields.content,
          message: fields.message,
          metadata: options.metadata,
        }}
      />,
    ),
  );
}

const PATH = "/srv/data/report.txt";

it("shows a backtick path of a one-line system line as a value, with no backticks", () => {
  const english = renderMessage([
    msg("systemEntries.pathRefusal.notFound", { path: PATH }),
  ]);
  const englishBox = english.container.firstElementChild as HTMLElement;
  // The one-line look is kept.
  expect(englishBox.style.textAlign).toBe("center");
  expect(dataChips(english.container)).toEqual([PATH]);
  expect(englishBox.textContent).not.toContain("`");
  const englishText = englishBox.textContent;
  english.unmount();

  // The reader's language words the line; the value stays apart.
  const spanish = renderMessage(
    [msg("systemEntries.pathRefusal.notFound", { path: PATH })],
    { language: "es" },
  );
  const spanishBox = spanish.container.firstElementChild as HTMLElement;
  expect(spanishBox.textContent).not.toBe(englishText);
  expect(dataChips(spanish.container)).toEqual([PATH]);
  expect(spanishBox.textContent).not.toContain("`");
  spanish.unmount();
});

it("shows the names in a one-line system line as values", () => {
  const view = renderMessage([
    msg("systemEntries.managerChanged", { actor: "Nil", member: "Ada" }),
  ]);
  expect(dataChips(view.container)).toEqual(["Nil", "Ada"]);
  view.unmount();
});

it("shows backtick spans of a one-line line with no message as values", () => {
  const view = renderSystem("Cannot open `notes.md` now.");
  expect(dataChips(view.container)).toEqual(["notes.md"]);
  expect(view.container.textContent).not.toContain("`");
  view.unmount();
});

it("shows the values of a multi-line notice apart, line breaks kept", () => {
  const view = renderMessage(
    [
      msg("systemEntries.settingsNotice.changed", { names: "Ada" }),
      "\n",
      msg("systemEntries.settingsNotice.change", {
        setting: msg("common.field.model"),
        from: "opus",
        to: "sonnet",
      }),
    ],
    { metadata: { notice: "settings" } },
  );
  const box = view.container.firstElementChild as HTMLElement;
  expect(box.style.whiteSpace).toBe("pre-wrap");
  expect(dataChips(view.container)).toEqual(["Ada", "opus", "sonnet"]);
  expect(box.textContent?.split("\n").length).toBe(2);
  view.unmount();
});

it("keeps a multi-line system line with a message on the Markdown path", () => {
  const view = renderMessage([
    msg("systemEntries.pathRefusal.notFound", { path: PATH }),
    "\n\nmore",
  ]);
  const box = view.container.firstElementChild as HTMLElement;
  expect(box.style.textAlign).toBe("left");
  expect(view.container.querySelectorAll("p").length).toBeGreaterThan(0);
  expect(view.container.querySelector("code")?.textContent).toBe(PATH);
  view.unmount();
});
