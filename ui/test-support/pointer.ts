// The primary pointer a test runs with: coarse on a phone or tablet, fine with
// a mouse or a trackpad. happy-dom answers (pointer: coarse) from
// navigator.maxTouchPoints, so a test that means a device says so here. Other
// media queries keep happy-dom's answer. Call the returned undo before the
// test ends; stubGlobal puts the real matchMedia back at the end of the file.
import { stubGlobal } from "./dom.ts";

type MatchMedia = typeof window.matchMedia;
const REAL = Symbol("real matchMedia");

export function primaryPointer(coarse: boolean): () => void {
  const current = window.matchMedia as MatchMedia & { [REAL]?: MatchMedia };
  const real = current[REAL] ?? current;
  const stub = ((query: string) =>
    query === "(pointer: coarse)"
      ? ({
          matches: coarse,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        } as MediaQueryList)
      : real.call(window, query)) as MatchMedia & { [REAL]?: MatchMedia };
  stub[REAL] = real;
  stubGlobal("matchMedia", stub);
  return () => stubGlobal("matchMedia", real);
}
