// The options of a native agent <select>, grouped by room (ui/agent-groups.ts):
// one <optgroup> per room, then the agents of no known room as plain options.
// The caller owns the <select> and any option before these.

import { groupAgentsByRoom } from "../agent-groups.ts";
import { noTranslate } from "../no-translate.ts";

export function AgentOptions<
  A extends { id: string; name: string; roomId: string; desk: number },
>({
  agents,
  rooms,
}: {
  agents: readonly A[];
  rooms: readonly { id: string; name: string }[];
}) {
  return groupAgentsByRoom(agents, rooms).map(({ room, agents: inRoom }) => {
    const options = inRoom.map((agent) => (
      <option key={agent.id} value={agent.id} {...noTranslate()}>
        {agent.name}
      </option>
    ));
    return room ? (
      <optgroup key={room.id} label={room.name} {...noTranslate()}>
        {options}
      </optgroup>
    ) : (
      options
    );
  });
}
