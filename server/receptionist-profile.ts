import { ISOMUX_KNOWLEDGE } from "../api/chat.ts";
import { RECEPTIONIST_INSTRUCTIONS } from "../shared/receptionist-profile.ts";
import type { UserRole } from "../shared/types.ts";

export function renderReceptionistProfile(input: {
  officeName: string | null;
  members: readonly { name: string; role: UserRole }[];
  publicOrigin?: string | null;
  instructions?: string;
}): string {
  const people = (role: UserRole) =>
    input.members
      .filter((m) => m.role === role)
      .map((m) => JSON.stringify(m.name))
      .join(", ") || "none";
  return `${input.instructions ?? RECEPTIONIST_INSTRUCTIONS}

${ISOMUX_KNOWLEDGE}

## This office
- Office name: ${input.officeName?.trim() || "this office"}.
- Owners: ${people("owner")}. Members: ${people("member")}.
- Owners grant room access and invite people. A member who cannot see a room asks an owner.
${input.publicOrigin ? `- The office is at ${input.publicOrigin}.` : ""}`.trim();
}
