export type DemoAppContent = {
  heading: string;
  valueSize: number;
  tiles: [label: string, value: string][];
};

const DEMO_APPS: Record<string, DemoAppContent> = {
  "cost-tracker": {
    heading: "Cost tracker",
    valueSize: 24,
    tiles: [
      ["This month", "$428"],
      ["API usage", "$276"],
      ["Infrastructure", "$152"],
    ],
  },
  "standup-board": {
    heading: "Standup board",
    valueSize: 13,
    tiles: [
      ["Yesterday", "Shipped app previews"],
      ["Today", "Polish the demo"],
      ["Blocked", "Nothing blocked"],
    ],
  },
};

export function demoAppMockContent(name: string): DemoAppContent {
  return (
    DEMO_APPS[name] ?? {
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
