// The style values the UI wrote, as written. happy-dom drops a value it does
// not parse, such as env(safe-area-inset-top) or max(env(...), 12px) outside
// a calc() (21.0), so `el.style` reads "" where a browser has the value.
// recordRawStyles() keeps each value an element's style was given, by
// property name, until the test file ends. It only records: what happy-dom
// stores does not change.

import { afterAll } from "bun:test";

const RAW = Symbol("raw-style");
type Recorded = { [RAW]?: Map<string, string> };

export function recordRawStyles(): void {
  const proto = Object.getPrototypeOf(document.createElement("div").style);
  const set = proto.setProperty;
  const remove = proto.removeProperty;
  proto.setProperty = function (
    this: Recorded,
    name: string,
    value: string | null,
    priority?: string,
  ) {
    const raw = (this[RAW] ??= new Map());
    if (value === null || value === "") raw.delete(name);
    else raw.set(name, String(value));
    return set.call(this, name, value, priority);
  };
  proto.removeProperty = function (this: Recorded, name: string) {
    this[RAW]?.delete(name);
    return remove.call(this, name);
  };
  afterAll(() => {
    proto.setProperty = set;
    proto.removeProperty = remove;
  });
}

// The values written to an element's style, by kebab-case property name.
export function rawStyle(el: HTMLElement): ReadonlyMap<string, string> {
  return (el.style as unknown as Recorded)[RAW] ?? new Map();
}
