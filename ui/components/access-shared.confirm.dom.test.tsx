// Revoke on an invite and on a session (task c6589760): a revoked link stops
// working and a revoked device is signed out, with no Undo, so each Revoke
// asks first. One row is armed at a time.

import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { InvitesTable, SessionsTable } = await import("./access-shared.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
type InviteWire = import("../../shared/types.ts").InviteWire;
type SessionWire = import("../../shared/types.ts").SessionWire;

const deleted: string[] = [];
setApiShim(async (method, path) => {
  if (method === "DELETE") deleted.push(path);
  return undefined;
});
afterAll(() => setApiShim(null));

const invite = (tokenPrefix: string): InviteWire => ({
  tokenPrefix,
  username: null,
  label: tokenPrefix,
  role: "member",
  createdBy: "u1",
  createdAt: 1,
  expiresAt: Date.now() + 86_400_000,
});
// The fixture's own session is 00000000: it has no Revoke.
const session = (sessionPrefix: string): SessionWire =>
  ({
    sessionPrefix,
    userId: "u2",
    username: "pat",
    createdAt: 1,
    lastSeenAt: 1,
    expiresAt: Date.now() + 86_400_000,
    absoluteExpiresAt: Date.now() + 86_400_000,
    userAgent: null,
    device: null,
  }) as SessionWire;

// The Revoke button of the row whose text holds `prefix`.
const revokeIn = (root: HTMLElement, prefix: string) => {
  const row = [...root.querySelectorAll("tr")].find((tr) =>
    tr.textContent?.includes(prefix),
  );
  const buttons = row?.querySelectorAll<HTMLElement>("button") ?? [];
  expect(buttons).toHaveLength(1);
  return buttons[0];
};
const click = (el: HTMLElement) =>
  act(async () => {
    fireEvent.click(el);
  });

for (const [label, element, paths] of [
  [
    "an invite",
    () =>
      onLanguage(
        "en",
        <InvitesTable invites={[invite("aaaa1111"), invite("bbbb2222")]} />,
      ),
    { first: "aaaa1111", other: "bbbb2222", path: "/api/invites/aaaa1111" },
  ],
  [
    "a session",
    () =>
      onLanguage(
        "en",
        <SessionsTable sessions={[session("aaaa1111"), session("bbbb2222")]} />,
      ),
    { first: "aaaa1111", other: "bbbb2222", path: "/api/sessions/aaaa1111" },
  ],
] as const)
  it(`Revoke on ${label} arms on the first click and sends nothing; another row's Revoke arms that row; the second click on the same row revokes it once`, async () => {
    deleted.length = 0;
    const view = render(element());
    const root = view.container;
    await click(revokeIn(root, paths.first));
    expect(deleted).toEqual([]);
    expect(revokeIn(root, paths.first).hasAttribute("data-confirm-armed")).toBe(
      true,
    );
    await click(revokeIn(root, paths.other));
    expect(deleted).toEqual([]);
    expect(revokeIn(root, paths.first).hasAttribute("data-confirm-armed")).toBe(
      false,
    );
    await click(revokeIn(root, paths.first));
    expect(deleted).toEqual([]);
    await click(revokeIn(root, paths.first));
    expect(deleted).toEqual([paths.path]);
    view.unmount();
  });
