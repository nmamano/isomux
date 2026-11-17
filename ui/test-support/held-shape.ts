// The block shape of a view, for the UI rule that a view keeps its layout
// while it loads (task 3755fad4). happy-dom lays nothing out, so a test
// compares the tree of block and control elements a pane draws while its
// read waits with the tree it draws once the answer arrived. Text and inline
// elements (strong, span, code, a) are left out: the held view draws the same
// lines and rows with blank or loading text.

const BLOCK = new Set([
  "DIV",
  "P",
  "SECTION",
  "FORM",
  "LABEL",
  "H3",
  "H4",
  "TABLE",
  "THEAD",
  "TBODY",
  "TR",
  "TD",
  "TH",
  "INPUT",
  "SELECT",
  "TEXTAREA",
  "BUTTON",
]);

export function blockShape(root: Element): string {
  const inner = [...root.children].map(blockShape).join("");
  return BLOCK.has(root.tagName) ? `${root.tagName}(${inner})` : inner;
}

// The controls inside the parts of a view that wait for a read.
export function heldControls(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll('[aria-busy="true"]')].flatMap((busy) => [
    ...busy.querySelectorAll<HTMLElement>("input, button, select, textarea"),
  ]);
}

// A promise and the function that settles it.
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
