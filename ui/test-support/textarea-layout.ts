// happy-dom has no layout, so a textarea has no heights and never scrolls
// itself. This gives every textarea the box a browser gives a chat composer:
// one 20px line per "\n"-line (no wrap) plus 4px of padding, and no border.
// The box is the style height in px; with style height auto (a composer's
// fit), as tall as its text; with no style height, the test's `box` for the
// field, else its rows, else as tall as its text. Like a browser, each layout
// clamps the scroll to what the box can scroll: a field that is as tall as
// its text (height auto) is back at the top.
export const LINE_HEIGHT = 20;
export const PADDING = 4;

export function textHeight(text: string): number {
  return text.split("\n").length * LINE_HEIGHT + PADDING;
}

// Installs the model on HTMLTextAreaElement.prototype and returns the undo.
// `box` gives the height of a field whose height comes from its place (a
// flex child), or null for the default.
export function layOutTextareas(opts?: {
  box?: (el: HTMLTextAreaElement) => number | null;
}): () => void {
  const proto = HTMLTextAreaElement.prototype;
  const keys = ["scrollHeight", "clientHeight", "offsetHeight", "scrollTop"];
  const saved = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)]),
  );
  const scroll = new WeakMap<HTMLTextAreaElement, number>();
  const content = (el: HTMLTextAreaElement) => textHeight(el.value);
  const client = (el: HTMLTextAreaElement) => {
    const height = el.style.height;
    if (height.endsWith("px")) return parseFloat(height);
    if (height === "") {
      const box = opts?.box?.(el);
      if (box != null) return box;
      const rows = Number(el.getAttribute("rows"));
      if (rows > 0) return rows * LINE_HEIGHT + PADDING;
    }
    return content(el);
  };
  const layout = (el: HTMLTextAreaElement) => {
    const max = Math.max(0, content(el) - client(el));
    const top = Math.min(Math.max(scroll.get(el) ?? 0, 0), max);
    scroll.set(el, top);
    return top;
  };
  Object.defineProperties(proto, {
    scrollHeight: {
      configurable: true,
      get(this: HTMLTextAreaElement) {
        layout(this);
        return Math.max(content(this), client(this));
      },
    },
    clientHeight: {
      configurable: true,
      get(this: HTMLTextAreaElement) {
        layout(this);
        return client(this);
      },
    },
    offsetHeight: {
      configurable: true,
      get(this: HTMLTextAreaElement) {
        layout(this);
        return client(this);
      },
    },
    scrollTop: {
      configurable: true,
      get(this: HTMLTextAreaElement) {
        return layout(this);
      },
      set(this: HTMLTextAreaElement, value: number) {
        scroll.set(this, value);
        layout(this);
      },
    },
  });
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else Reflect.deleteProperty(proto, key);
    }
  };
}

// The field shows its last line: it overflows, and it is scrolled to the end.
// The overflow is the condition that makes the scroll mean anything.
export function scrolledToEnd(el: HTMLTextAreaElement): {
  overflows: boolean;
  atEnd: boolean;
} {
  return {
    overflows: el.scrollHeight > el.clientHeight,
    atEnd:
      el.scrollTop > 0 && el.scrollTop + el.clientHeight === el.scrollHeight,
  };
}
