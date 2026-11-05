// An office for the agent selector tests (task 899360d3, AGENTS.md "UI
// rules": an agent selector groups agents by room). The office order of the
// rooms is not by name, an empty room sits between two others, the input
// order of the agents is neither desk order nor name order, one agent has a
// back seat, and two agents are in a room the viewer does not see.

export const GROUP_ROOMS = [
  { id: "r2", name: "Zeta" },
  { id: "r3", name: "Empty" },
  { id: "r1", name: "Alpha" },
];

export const GROUP_AGENTS = [
  { id: "x1", name: "Ann", roomId: "r1", desk: 3 },
  { id: "x2", name: "Bob", roomId: "r2", desk: 5 },
  { id: "x3", name: "Cid", roomId: "r1", desk: 1 },
  { id: "x4", name: "Dee", roomId: "r9", desk: 0 },
  { id: "x5", name: "Eve", roomId: "r2", desk: 2 },
  { id: "x6", name: "Abe", roomId: "r9", desk: 1 },
  // A back seat: after the front desks of its room, whatever its name.
  { id: "x7", name: "Aal", roomId: "r2", desk: 9 },
];

// The children of a native <select>, in order: an option as its value, an
// optgroup as "<label>: <values>".
export function selectGroups(select: HTMLSelectElement): string[] {
  return [...select.children].map((child) =>
    child instanceof HTMLOptGroupElement
      ? `${child.label}: ${[...child.querySelectorAll("option")]
          .map((option) => option.value)
          .join(",")}`
      : (child as HTMLOptionElement).value,
  );
}

// GROUP_AGENTS under GROUP_ROOMS, as selectGroups reads it.
export const GROUPED_SELECT = ["Zeta: x5,x2,x7", "Alpha: x3,x1", "x4", "x6"];
