// The engine setting's one control (task ff602b30): a group of option tiles,
// one button per engine, the same in the New agent dialog, Agent settings and
// the schedule dialog. Shared by the DOM tests that read or pick an engine.
// Load it with `await import(...)` after setUpDomTestFile().
import { act, fireEvent } from "@testing-library/react";

export const ENGINES = ["claude", "codex", "opencode"] as const;

export function engineGroup(root: ParentNode): HTMLElement {
  const groups = root.querySelectorAll<HTMLElement>(".engine-options");
  if (groups.length !== 1)
    throw new Error(`expected one engine group, found ${groups.length}`);
  return groups[0];
}

export function engineTile(
  root: ParentNode,
  engine: string,
): HTMLButtonElement {
  const tile = engineGroup(root).querySelector<HTMLButtonElement>(
    `button[data-engine="${engine}"]`,
  );
  if (!tile) throw new Error(`no ${engine} engine tile`);
  return tile;
}

// Each engine's tile: disabled or not.
export function enginesDisabled(root: ParentNode): Record<string, boolean> {
  return Object.fromEntries(
    ENGINES.map((engine) => [engine, engineTile(root, engine).disabled]),
  );
}

// The engines whose tile is pressed.
export function pressedEngines(root: ParentNode): string[] {
  return [
    ...engineGroup(root).querySelectorAll<HTMLButtonElement>(
      'button[aria-pressed="true"]',
    ),
  ].map((tile) => tile.dataset.engine ?? "");
}

export async function pickEngine(
  root: ParentNode,
  engine: string,
): Promise<void> {
  const tile = engineTile(root, engine);
  if (tile.disabled) throw new Error(`the ${engine} engine tile is disabled`);
  await act(async () => {
    fireEvent.click(tile);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
