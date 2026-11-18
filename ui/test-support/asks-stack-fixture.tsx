// The ask stack's office (internal-docs/asks-design.md), shared by
// ui/log-view/AsksStack.dom.test.tsx (the cards, their answers and links),
// AsksStack.reply.dom.test.tsx (the options and the reply field) and
// AsksStack.prompt.dom.test.tsx (the prompt's markup, the simplify banner and
// the stack's height and scroll), split because the 5 s cap is per file.
// Import it with `await import(...)` after setUpDomTestFile(), like every DOM
// module.
//
// Each test file keeps its own API shim state (posts, answer): a test assigns
// them, and an imported binding cannot be assigned.
const { render } = await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useDispatch } = await import("../store.tsx");
const { AsksStack } = await import("../log-view/AsksStack.tsx");
const { OfficeLinkOpener } = await import("../office-link.tsx");
type AskEntry = import("../../shared/types.ts").AskEntry;
type OfficeLink = import("../../shared/office-links.ts").OfficeLink;

export const NOW = Date.now();
export const entry = (
  id: string,
  agentId: string,
  prompt: string,
  ageMin: number,
): AskEntry => ({
  id,
  agentId,
  memberUserId: "u1",
  prompt,
  createdAt: NOW - ageMin * 60_000,
  updatedAt: NOW - ageMin * 60_000,
});
export const ENTRIES: AskEntry[] = [
  entry("bbbb0002", "a1", "Second question?", 5),
  entry("aaaa0001", "a1", "First question?", 120),
  entry("cccc0003", "a2", "Another agent's question?", 1),
  // Agent a3's asks carry links: one this UI knows, one it does not.
  {
    ...entry("dddd0004", "a3", "Sign in to Linear?", 3),
    link: "/integrations/mcp",
  },
  { ...entry("eeee0005", "a3", "Open the old page?", 2), link: "/gone" },
  // Agent a4's ask has options.
  {
    ...entry("ffff0006", "a4", "Who gives the toast?", 4),
    options: ["Jim", "Dwight"],
  },
  // Agent a5 has a secret request between two reply asks.
  entry("gggg0007", "a5", "Ship it?", 30),
  {
    ...entry("hhhh0008", "a5", "To open the pull request.", 20),
    secret: {
      requestId: "req-1",
      scope: "personal",
      name: "GH_TOKEN",
      hosts: ["api.github.com"],
      form: { kind: "authorization" },
      reason: "To open the pull request.",
    },
  },
  entry("iiii0009", "a5", "Tag it?", 10),
  // Agent a6's ask carries chat affordances.
  {
    ...entry("jjjj0010", "a6", "Delete the merged branches?", 6),
    commands: ["git branch -D t-a && git push origin --delete t-a"],
    editFiles: [{ cwd: "/w", path: "/w/notes.md" }],
    readFiles: [
      {
        filename: "ab12.png",
        originalName: "plot.png",
        mediaType: "image/png",
        size: 7,
      },
      // A video referenced where it is (task 37a660e8): served by the ask's
      // own file route, not the agent's files dir.
      {
        filename: "ef56.mp4",
        originalName: "clip.mp4",
        mediaType: "video/mp4",
        size: 9,
        path: "/w/clip.mp4",
      },
      {
        filename: "cd34.txt",
        originalName: "log.txt",
        mediaType: "text/plain",
        size: 3,
      },
    ],
  },
  // Agent a7's asks link to agents' chats: one this UI knows, one it does not.
  {
    ...entry("kkkk0011", "a7", "Say go in Scout's chat?", 8),
    link: "/agents/a1",
  },
  {
    ...entry("llll0012", "a7", "Say go in Ghost's chat?", 7),
    link: "/agents/ghost",
  },
  // Agent a8's asks recommend an option: the second one, and one that is not
  // among the options (the card ignores it).
  {
    ...entry("mmmm0013", "a8", "Keep the verifier rule?", 9),
    options: ["Yes", "No"],
    recommended: "No",
  },
  {
    ...entry("nnnn0014", "a8", "Keep the old rule?", 8),
    options: ["Yes", "No"],
    recommended: "Maybe",
  },
  // Agent a9's first ask is from an app behind it (task 1f453011).
  {
    ...entry("oooo0015", "a9", "Merge the queue?", 6),
    app: { name: "triage-bot", createdAt: NOW - 86_400_000 },
  },
  entry("pppp0016", "a9", "Its own question?", 5),
  // Agent b1's asks and a simplify request (task 30915188): none, one
  // waiting for the rewrite, and one rewritten.
  entry("qqqq0017", "b1", "Merge t-1 after the CI on f00d?", 9),
  // A second round: rewritten once, and asked again.
  {
    ...entry("rrrr0018", "b1", "Rotate the key?", 8),
    simplifyRequestedAt: NOW,
    originalPrompt: "Rotate k-7?",
  },
  {
    ...entry("ssss0019", "b1", "Merge the fix now?", 7),
    originalPrompt: "Merge `t-1` after the CI on f00d?",
  },
  // Agent b2's ask carries copy changes as ```diff blocks (task 8c661856),
  // in the prompt and in the original.
  {
    ...entry(
      "tttt0020",
      "b2",
      "Approve the copy in `AskCard`?\n```diff\nAsk card > link:\n- Show original\n+ Show the first version\n```\nShip it?",
      3,
    ),
    originalPrompt: "Old ask:\n```diff\n- Save now\n+ Save later\n```",
  },
  // Agent b3's ask is a step the member does, with one option (task d05f2968).
  {
    ...entry("uuuu0021", "b3", "Reload the extension?", 2),
    options: ["Done"],
  },
  // Agent b4's asks link to one ask in the Inbox: another ask, and the ask
  // itself.
  {
    ...entry("abcd0022", "b4", "See the other ask?", 2),
    link: "/inbox/asks/abcd0099",
  },
  {
    ...entry("abcd0023", "b4", "See this ask?", 1),
    link: "/inbox/asks/abcd0023",
  },
  // Agent b5's asks link outside the office (task 0355f4b7): an https page,
  // and a stored link this UI refuses.
  {
    ...entry("abcd0024", "b5", "Make a token?", 2),
    link: "https://WWW.GitHub.com/settings/tokens/new?scopes=repo",
  },
  { ...entry("abcd0025", "b5", "Open it?", 1), link: "javascript:alert(1)" },
];
// The one agent the store knows: the target of a7's first link.
const SCOUT = { id: "a1", name: "Scout", roomId: "r2", desk: 0 } as never;

// The store's dispatch, for a change after the cards are drawn.
let dispatchNow: ReturnType<typeof useDispatch> = () => {};
/** A test file destructures this from the import, so it is a stable function
 *  that calls the dispatch of the latest mount. */
export const seeded: ReturnType<typeof useDispatch> = (action) =>
  dispatchNow(action);
export function Seed({ children }: { children: React.ReactNode }) {
  const dispatch = useDispatch();
  useEffect(() => {
    dispatchNow = dispatch;
    dispatch({ type: "agent_added", agent: SCOUT });
    dispatch({ type: "asks_loaded", entries: ENTRIES, revision: 0 });
  }, [dispatch]);
  return <>{children}</>;
}

export function tree(
  isMobile: boolean,
  agentId = "a1",
  opener: ((link: OfficeLink) => void) | null = null,
  maxHeight?: number,
) {
  return (
    <StoreProvider>
      <OfficeLinkOpener.Provider value={opener}>
        <Seed>
          <AsksStack
            agentId={agentId}
            isMobile={isMobile}
            maxHeight={maxHeight}
          />
        </Seed>
      </OfficeLinkOpener.Provider>
    </StoreProvider>
  );
}

export function mount(
  isMobile: boolean,
  agentId = "a1",
  opener: ((link: OfficeLink) => void) | null = null,
) {
  return render(tree(isMobile, agentId, opener));
}

export const cards = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("[data-ask]")].map(
    (c) => c.dataset.ask,
  );
