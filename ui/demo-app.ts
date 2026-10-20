import type { AppWire } from "../shared/types.ts";

// Both demo bundles import this module: the office (ui/demo-server.ts) lists
// these apps, and the standalone app page shows each one's `page`. Keep it to
// type imports, so the app page bundle does not pull in office code.

export type DemoAppContent = {
  heading: string;
  valueSize: number;
  tiles: [label: string, value: string][];
};

export type DemoAppFixture = AppWire & { page: DemoAppContent };

// Agent-built apps. The demo has no systemd, so `state` is whatever the last
// verb set it to - enough to exercise the Apps tab's list, verbs and log view.
// Both seeds start healthy so the customer-facing demo opens on working apps.
//
// The creators are deliberately one of each: `standup-board` names an agent the
// demo office still has, so its row links to that conversation and the app
// belongs to that agent's room, while `cost-tracker` names one it does not and
// stays plain text with no room.
export const demoAppFixtures: readonly DemoAppFixture[] = [
  {
    name: "standup-board",
    hostLabel: "standup-board",
    hostGen: 1,
    port: 21000,
    command: "bun run serve.ts",
    cwd: "/home/ricky/standup-board",
    description: "Morning standup notes, one card per agent.",
    dataDir: "/home/ricky/.isomux/apps/data/standup-board",
    userId: "demo-user",
    username: "Ricky",
    createdBy: "Pam",
    createdByAgentId: "demo-pam",
    createdAt: Date.now() - 86_400_000,
    state: "running",
    restartCount: 0,
    url: "https://standup-board.office.example",
    page: {
      heading: "Standup board",
      valueSize: 13,
      tiles: [
        ["Yesterday", "Shipped app previews"],
        ["Today", "Polish the demo"],
        ["Blocked", "Nothing blocked"],
      ],
    },
  },
  {
    name: "cost-tracker",
    hostLabel: "cost-tracker",
    hostGen: 1,
    port: 21001,
    command: "bun run index.ts --watch",
    cwd: "/home/ricky/cost-tracker",
    description: "Token spend per room, refreshed hourly.",
    dataDir: "/home/ricky/.isomux/apps/data/cost-tracker",
    userId: "demo-user",
    username: "Ricky",
    createdBy: "Ledger",
    createdAt: Date.now() - 3_600_000,
    state: "running",
    restartCount: 0,
    url: "https://cost-tracker.office.example",
    page: {
      heading: "Cost tracker",
      valueSize: 24,
      tiles: [
        ["This month", "$428"],
        ["API usage", "$276"],
        ["Infrastructure", "$152"],
      ],
    },
  },
];

export function demoAppMockContent(name: string): DemoAppContent {
  return (
    demoAppFixtures.find((app) => app.name === name)?.page ?? {
      heading: "Demo app",
      valueSize: 13,
      tiles: [
        ["Preview", "Demo app"],
        ["Workspace", "Sample content"],
        ["Status", "Ready"],
      ],
    }
  );
}
