// Every agent selector groups agents by room (AGENTS.md "UI rules", Nil,
// 2026-11-05). The groups follow `rooms` order, which is the office order;
// inside a room, agents follow desk order, so the front seats come before the
// back seats. Rooms with no agent are left out. An agent whose room is not in
// `rooms` goes in one last group with room null, in input order. The caller
// picks which agents to show before it calls.
export function groupAgentsByRoom<
  A extends { roomId: string; desk: number },
  R extends { id: string },
>(
  agents: readonly A[],
  rooms: readonly R[],
): { room: R | null; agents: A[] }[] {
  const groups: { room: R | null; agents: A[] }[] = rooms
    .map((room) => ({
      room,
      agents: agents
        .filter((agent) => agent.roomId === room.id)
        .sort((a, b) => a.desk - b.desk),
    }))
    .filter((group) => group.agents.length > 0);
  const known = new Set(rooms.map((room) => room.id));
  const roomless = agents.filter((agent) => !known.has(agent.roomId));
  if (roomless.length > 0) groups.push({ room: null, agents: roomless });
  return groups;
}

// The Revive a killed agent list (spawn dialog), grouped by room like every
// agent selector. A killed agent has no desk: its room is lastRoomId. The
// groups follow `rooms` order and take the room's current name; inside a
// group, agents keep input order (newest killed first). A room not in
// `rooms` gets its own group after them, named by lastRoomName, in order of
// first appearance.
export function groupKilledAgentsByRoom<
  K extends { lastRoomId: string; lastRoomName: string },
>(
  killed: readonly K[],
  rooms: readonly { id: string; name: string }[],
): { roomId: string; roomName: string; agents: K[] }[] {
  const groups = rooms
    .map((room) => ({
      roomId: room.id,
      roomName: room.name,
      agents: killed.filter((agent) => agent.lastRoomId === room.id),
    }))
    .filter((group) => group.agents.length > 0);
  const known = new Set(rooms.map((room) => room.id));
  const gone = new Map<
    string,
    { roomId: string; roomName: string; agents: K[] }
  >();
  for (const agent of killed) {
    if (known.has(agent.lastRoomId)) continue;
    const group = gone.get(agent.lastRoomId);
    if (group) group.agents.push(agent);
    else
      gone.set(agent.lastRoomId, {
        roomId: agent.lastRoomId,
        roomName: agent.lastRoomName,
        agents: [agent],
      });
  }
  return [...groups, ...gone.values()];
}
