// Recording mode in a CodeMirror editor (EditorPanel, SkillSourceEditor):
// each match in view is drawn as its stand-in, and the document stays the
// real text, so a save never writes a stand-in. The page-wide layer skips
// .cm-editor for that reason.

import {
  StateEffect,
  type Extension,
  RangeSetBuilder,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import type { RedactedSpan, Redactor } from "../../shared/recording-redact.ts";
import { currentRedactor, onRecordingChange } from "../recording-mode.ts";

class StandInWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: StandInWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-recording-stand-in";
    span.textContent = this.text;
    return span;
  }
}

// A redactor without spans (a test's): the changed middle of the line, from
// the common start and end, as one span.
function spansOf(redact: Redactor, text: string): RedactedSpan[] {
  if (redact.spans) return redact.spans(text);
  const out = redact(text);
  if (out === text) return [];
  let start = 0;
  while (
    start < text.length &&
    start < out.length &&
    text[start] === out[start]
  )
    start++;
  let end = 0;
  while (
    end < text.length - start &&
    end < out.length - start &&
    text[text.length - 1 - end] === out[out.length - 1 - end]
  )
    end++;
  return [
    {
      from: start,
      to: text.length - end,
      standIn: out.slice(start, out.length - end),
    },
  ];
}

const refresh = StateEffect.define<null>();

// `source` gives the redactor in force, or null while the mode is off; by
// default recording mode's own. The editor redraws on every mode or rule
// change.
export function recordingRedaction(
  source: () => Redactor | null = currentRedactor,
): Extension {
  const build = (view: EditorView): DecorationSet => {
    const redact = source();
    if (!redact) return Decoration.none;
    const builder = new RangeSetBuilder<Decoration>();
    const doc = view.state.doc;
    let lastLine = -1;
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const line = doc.lineAt(pos);
        if (line.number > lastLine) {
          lastLine = line.number;
          for (const span of spansOf(redact, line.text))
            builder.add(
              line.from + span.from,
              line.from + span.to,
              Decoration.replace({ widget: new StandInWidget(span.standIn) }),
            );
        }
        pos = line.to + 1;
      }
    }
    return builder.finish();
  };

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private readonly unsubscribe: () => void;
      constructor(readonly view: EditorView) {
        this.decorations = build(view);
        this.unsubscribe = onRecordingChange(() =>
          view.dispatch({ effects: refresh.of(null) }),
        );
      }
      update(u: ViewUpdate) {
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)))
        )
          this.decorations = build(u.view);
      }
      destroy() {
        this.unsubscribe();
      }
    },
    { decorations: (p) => p.decorations },
  );
  // The cursor steps over a stand-in as one piece.
  return [
    plugin,
    EditorView.atomicRanges.of(
      (view) => view.plugin(plugin)?.decorations ?? Decoration.none,
    ),
  ];
}
