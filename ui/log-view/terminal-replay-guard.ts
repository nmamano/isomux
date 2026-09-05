// Keeps the replayed scrollback from talking back to the PTY.
//
// The server answers `terminal_open` with the agent's whole PTY scrollback
// (server/isomux-office.ts), and the panel writes it into a terminal that was
// created a moment ago. xterm.js cannot tell that history from live output: it
// parses a terminal QUERY the same way whenever it arrives, and a query is
// answered by writing to the PTY. So a background-colour query (OSC 11 ?) or a
// cursor-position request (CSI 6 n) that any program left in the scrollback is
// answered again on every mount, the shell echoes the answer at its prompt, and
// the boss sees a line grow one `11;rgb:0a0a/0e0e/1616` per visit to the agent.
//
// The answer to a stale query is worthless, so the guard suppresses it. The
// answer to a LIVE query is not - Claude Code and other TUIs probe the terminal
// on startup - so suppression lasts exactly as long as the replayed chunk is
// being parsed, and the flag comes off in xterm's own write callback. That is
// also why the guard sits at the parser and not on `onData`: a keystroke that
// landed mid-replay would be dropped by an `onData` gate, and no keystroke can
// reach a parser handler.

/** The parts of xterm's parser the guard registers on. */
interface QueryParser {
  registerCsiHandler(
    id: { prefix?: string; intermediates?: string; final: string },
    callback: (params: (number | number[])[]) => boolean,
  ): { dispose(): void };
  registerDcsHandler(
    id: { prefix?: string; intermediates?: string; final: string },
    callback: (data: string, params: (number | number[])[]) => boolean,
  ): { dispose(): void };
  registerOscHandler(
    ident: number,
    callback: (data: string) => boolean,
  ): { dispose(): void };
}

/** A real `Terminal` satisfies this; a test can pass a stand-in. */
export interface GuardableTerminal {
  parser: QueryParser;
  write(data: string, callback?: () => void): void;
}

export interface ReplayGuard {
  /** Writes a replayed chunk with xterm's query answers suppressed. */
  writeReplay(data: string, done?: () => void): void;
  /** True while at least one replayed chunk is still being parsed. */
  suppressing(): boolean;
  dispose(): void;
}

// OSC idents whose payload can be a report request. xterm answers `?` for the
// indexed palette (4), the foreground (10), the background (11) and the cursor
// colour (12); the other OSC idents it implements set or restore, and never
// reply. Anything that is not a query has to fall through to xterm, or a
// replayed colour CHANGE would stop applying and the scrollback would render
// in the wrong colours.
const COLOR_OSC_IDENTS = [4, 10, 11, 12];

// CSI window operations that report back (xterm's `windowOptions`): window size
// in pixels, cell size in pixels, text area size in characters. The others in
// CSI t act on the window or the title stack and must keep working during a
// replay. All of these are inert unless the terminal enables `windowOptions`,
// which this panel does not; they are listed so that enabling it later cannot
// reopen this bug.
const WINDOW_REPORT_OPS = [14, 16, 18];

function isColorQuery(data: string): boolean {
  return data.split(";").some((part) => part === "?");
}

function firstParam(params: (number | number[])[]): number {
  const first = params[0];
  return Array.isArray(first) ? (first[0] ?? 0) : (first ?? 0);
}

/**
 * Registers the guard on a terminal. Returns the handle the panel writes
 * replayed chunks through, and disposes with the terminal.
 *
 * Each handler returns true (sequence handled, nothing sent) while a replayed
 * chunk is in flight, and false the rest of the time, which hands the sequence
 * back to xterm's own handler underneath. Suppression is counted, not a
 * boolean, so a second replay - a reconnect that re-opens the terminal - cannot
 * be un-suppressed by the first one's callback.
 */
export function installReplayGuard(term: GuardableTerminal): ReplayGuard {
  let pending = 0;
  const suppressing = () => pending > 0;

  const parser = term.parser;
  const disposables = [
    // Device attributes: DA1 (CSI c) and DA2 (CSI > c).
    parser.registerCsiHandler({ final: "c" }, suppressing),
    parser.registerCsiHandler({ prefix: ">", final: "c" }, suppressing),
    // Device status report, including the cursor-position request CSI 6 n.
    parser.registerCsiHandler({ final: "n" }, suppressing),
    parser.registerCsiHandler({ prefix: "?", final: "n" }, suppressing),
    // DECRQM, ANSI and private forms.
    parser.registerCsiHandler({ intermediates: "$", final: "p" }, suppressing),
    parser.registerCsiHandler(
      { prefix: "?", intermediates: "$", final: "p" },
      suppressing,
    ),
    // DECRQSS.
    parser.registerDcsHandler({ intermediates: "$", final: "q" }, suppressing),
    parser.registerCsiHandler(
      { final: "t" },
      (params) =>
        suppressing() && WINDOW_REPORT_OPS.includes(firstParam(params)),
    ),
    ...COLOR_OSC_IDENTS.map((ident) =>
      parser.registerOscHandler(
        ident,
        (data) => suppressing() && isColorQuery(data),
      ),
    ),
  ];

  return {
    writeReplay(data, done) {
      pending++;
      term.write(data, () => {
        pending--;
        done?.();
      });
    },
    suppressing,
    dispose() {
      for (const disposable of disposables) disposable.dispose();
    },
  };
}
