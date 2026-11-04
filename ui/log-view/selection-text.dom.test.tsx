// A selection over rendered math reads as the TeX source between dollars, for
// the copy handler and the Cite pill alike: KaTeX's MathML and HTML spans come
// out one character per line otherwise. How the browser lays out the text
// around a formula (newlines between blocks, white-space) needs a real browser
// and is not checked here.

import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, cleanup, waitFor, act } =
  await import("@testing-library/react");
const { createRef } = await import("react");
const { Markdown } = await import("./Markdown.tsx");
const { ChatTranscript, useChatTranscript } =
  await import("./ChatTranscript.tsx");
const { useSelectionCite } = await import("./useSelectionCite.ts");
const { selectionText } = await import("./selection-text.ts");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
type LogEntry = import("../../shared/types.ts").LogEntry;
type CiteSelection = import("./useSelectionCite.ts").CiteSelection;

const happyDOM = (
  window as unknown as {
    happyDOM: {
      settings: {
        disableCSSFileLoading: boolean;
        handleDisabledFileLoadingAsSuccess: boolean;
      };
    };
  }
).happyDOM;
happyDOM.settings.disableCSSFileLoading = true;
happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;
afterAll(() => cleanup());

const PARAGRAPH = String.raw`Runs in $O(n\log^{11/12} n)$ at $\beta=3/4$, as shown.`;

async function renderMath(content: string, formulas: number) {
  const view = render(onLanguage("en", <Markdown content={content} />));
  await waitFor(() => {
    expect(view.container.querySelectorAll(".katex").length).toBe(formulas);
  });
  return view.container;
}

function textNodeOf(root: Element, text: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if (n.textContent?.includes(text)) return n as Text;
  throw new Error(`no text node holds ${text}`);
}

// A text node of a formula's visible HTML (not its MathML copy).
function glyphOf(formula: Element, glyph: string): Text {
  return textNodeOf(formula.querySelector(".katex-html")!, glyph);
}

function select(
  start: Node,
  startOffset: number,
  end: Node,
  endOffset: number,
): Selection {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function formulas(root: Element): Element[] {
  return [...root.querySelectorAll(".katex-math")];
}

describe("selectionText", () => {
  it("reads a selection that touches no formula as the browser does", async () => {
    const root = await renderMath(`${PARAGRAPH}\n\nNo math *here* at all.`, 2);
    const start = textNodeOf(root, "No math");
    const end = textNodeOf(root, "at all.");
    const sel = select(start, 3, end, end.length - 1);
    expect(sel.toString()).toBe("math here at all");
    expect(selectionText(sel)).toBe("math here at all");
    // The text after the last formula, in the same paragraph.
    const tail = textNodeOf(root, "as shown.");
    const tailSel = select(tail, 0, tail, tail.length);
    expect(selectionText(tailSel)).toBe(tailSel.toString());
  });

  it("puts each formula inside the selection back as its source", async () => {
    const root = await renderMath(PARAGRAPH, 2);
    expect(root.querySelectorAll("math").length).toBe(2);
    const start = textNodeOf(root, "Runs in");
    const end = textNodeOf(root, "as shown.");
    const sel = select(start, 0, end, end.length);
    // The enabling condition: the browser's own text holds the MathML.
    expect(sel.toString().includes("$")).toBe(false);
    expect(selectionText(sel)).toBe(PARAGRAPH);
  });

  it("takes a whole formula when the selection starts or ends inside it", async () => {
    const root = await renderMath(PARAGRAPH, 2);
    const [big, beta] = formulas(root);
    const shown = textNodeOf(root, "as shown.");
    const runs = textNodeOf(root, "Runs in");

    const fromInside = select(glyphOf(big, "lo"), 1, shown, shown.length);
    expect(selectionText(fromInside)).toBe(
      String.raw`$O(n\log^{11/12} n)$ at $\beta=3/4$, as shown.`,
    );

    const intoFormula = select(runs, 0, glyphOf(beta, "β"), 0);
    expect(selectionText(intoFormula)).toBe(
      String.raw`Runs in $O(n\log^{11/12} n)$ at $\beta=3/4$`,
    );

    const within = select(glyphOf(beta, "β"), 0, glyphOf(beta, "4"), 1);
    expect(selectionText(within)).toBe(String.raw`$\beta=3/4$`);
  });

  it("gives display math double dollars on a line of its own", async () => {
    const root = await renderMath(
      String.raw`Before.

$$\int_0^1 x\,dx$$

After.`,
      1,
    );
    const start = textNodeOf(root, "Before.");
    const end = textNodeOf(root, "After.");
    const lines = selectionText(select(start, 0, end, end.length)).split("\n");
    expect(lines[0]).toBe("Before.");
    expect(lines).toContain(String.raw`$$\int_0^1 x\,dx$$`);
    expect(lines.at(-1)).toBe("After.");
  });

  it("puts back a formula KaTeX has not rendered, with its source trimmed", () => {
    const view = render(
      <p>
        {"See "}
        <span
          className="katex-math"
          data-katex-source=" x^2 "
          data-katex-display="false"
        >
          {" x^2 "}
        </span>
        {" here."}
      </p>,
    );
    const p = view.container.querySelector("p")!;
    const sel = select(p.firstChild!, 0, p.lastChild!, 6);
    expect(sel.toString()).toBe("See  x^2  here.");
    expect(selectionText(sel)).toBe("See $x^2$ here.");
  });

  it("leaves the selection and the page as they were", async () => {
    const root = await renderMath(PARAGRAPH, 2);
    const html = root.innerHTML;
    const [, beta] = formulas(root);
    const runs = textNodeOf(root, "Runs in");
    const glyph = glyphOf(beta, "β");
    const sel = select(runs, 2, glyph, 0);
    selectionText(sel);
    const range = sel.getRangeAt(0);
    expect([
      range.startContainer === runs,
      range.startOffset,
      range.endContainer === glyph,
      range.endOffset,
    ]).toEqual([true, 2, true, 0]);
    expect(root.innerHTML).toBe(html);
  });
});

describe("where the chat reads a selection", () => {
  function reply(id: string, content: string): LogEntry {
    return { id, agentId: "a", timestamp: 1, kind: "text", content };
  }

  function Transcript({ logs }: { logs: LogEntry[] }) {
    const view = useChatTranscript(logs, false);
    return <ChatTranscript logs={logs} view={view} isMobile={false} />;
  }

  it("copies a selection over math as the source", async () => {
    const view = render(
      onLanguage("en", <Transcript logs={[reply("r1", PARAGRAPH)]} />),
    );
    await waitFor(() => {
      expect(view.container.querySelectorAll(".katex").length).toBe(2);
    });
    const start = textNodeOf(view.container, "Runs in");
    const end = textNodeOf(view.container, "as shown.");
    const sel = select(start, 0, end, end.length);
    expect(sel.toString().includes("$")).toBe(false);

    const writes: Array<[string, string]> = [];
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        setData: (type: string, value: string) => writes.push([type, value]),
      },
    });
    start.parentElement!.dispatchEvent(event);
    expect(writes).toEqual([["text/plain", PARAGRAPH]]);
    cleanup();
  });

  it("gives the Cite pill the source", async () => {
    const container = createRef<HTMLDivElement>();
    let seen: CiteSelection | null = null;
    function Chat() {
      const { cite } = useSelectionCite(container, true);
      seen = cite;
      return (
        <div ref={container}>
          <Markdown content={PARAGRAPH} />
        </div>
      );
    }
    const view = render(onLanguage("en", <Chat />));
    await waitFor(() => {
      expect(view.container.querySelectorAll(".katex").length).toBe(2);
    });
    // happy-dom has no layout: give the selection and the chat a box.
    const box = new DOMRect(10, 10, 100, 20);
    // Descriptors: happy-dom's classes outlive the window, and an assignment
    // back would leave an own getBoundingClientRect on HTMLElement.prototype
    // that hides Element's for every later file in the process.
    const rects = Object.getOwnPropertyDescriptor(
      Range.prototype,
      "getClientRects",
    );
    const bounds = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "getBoundingClientRect",
    );
    Range.prototype.getClientRects = () =>
      Object.assign([box], { item: () => box }) as unknown as DOMRectList;
    HTMLElement.prototype.getBoundingClientRect = () =>
      new DOMRect(0, 0, 500, 500);
    const putBack = (target: object, name: string, d?: PropertyDescriptor) => {
      if (d) Object.defineProperty(target, name, d);
      else Reflect.deleteProperty(target, name);
    };
    try {
      const start = textNodeOf(view.container, "Runs in");
      const end = textNodeOf(view.container, "as shown.");
      await act(async () => {
        select(start, 0, end, end.length);
        document.dispatchEvent(new Event("selectionchange"));
      });
      await waitFor(() => {
        expect(seen?.text).toBe(PARAGRAPH);
      });
    } finally {
      putBack(Range.prototype, "getClientRects", rects);
      putBack(HTMLElement.prototype, "getBoundingClientRect", bounds);
    }
  });
});
