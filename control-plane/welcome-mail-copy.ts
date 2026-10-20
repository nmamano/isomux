// The welcome series: what each mail says. English only, plain text.
//
// A DRAFT until Nil signs it off: WELCOME_MAIL_SENDING in welcome-mail.ts stays
// false until he does. The copy cannot depend on what the customer did in the
// office, because after setup we have no access to it.
//
// {officeUrl} is replaced with the office address, {dashboardUrl} with the
// customer dashboard. The unsubscribe line and the
// postal address are added by welcome-mail.ts, not written here.

export interface WelcomeMailCopy {
  subject: string;
  body: string;
}

/** One entry per step, in the order of WELCOME_MAIL_OFFSETS_MS. */
export const WELCOME_MAILS: readonly WelcomeMailCopy[] = [
  {
    subject: "Your Isomux office is ready",
    body: `Your office is up at {officeUrl}.

To sign in the first time, get your owner invite from your dashboard at {dashboardUrl} and open it in the browser where you will use the office. Then confirm on the dashboard that the office is open, so we remove our setup access.

Three welcome agents are waiting at their desks, one each for Claude, Codex and OpenCode. The OpenCode one runs on a free model, so you can talk to it right away.

Over the next two weeks we will send you a few short tips. Reply to any of them if something does not work.`,
  },
  {
    subject: "Connect a model",
    body: `The free welcome agent works out of the box. For Claude or Codex, the office needs your own account.

In your office, open Integrations, then the Model providers tab, and sign in to Claude or Codex.

{officeUrl}`,
  },
  {
    subject: "Your office on your phone, and your team in it",
    body: `Open {officeUrl} on your phone. It is the same office, with the same agents and conversations, live.

On iPhone, use Safari's Share menu and "Add to Home Screen". On Android, Chrome offers to install it.

To bring someone in, open Settings, select New member at the end of the Members list, and send them their sign-in link. You choose which rooms they see.`,
  },
  {
    subject: "Let the agents work together",
    body: `A few things to try this week:

- Rooms: give each project its own room, with its own instructions.
- The task board: you and the agents file, claim and close tasks.
- Agents can message each other, and read each other's conversations.
- Schedules: an agent runs on its own every day, every week or every few minutes.

{officeUrl}`,
  },
  {
    subject: "Apps, your browser, and what is missing",
    body: `Two more things an office can do:

- Apps: ask an agent to build you a small web app. It runs in the office, behind your sign-in, and opens from any device.
- The Chrome extension: an agent can read and act on a tab you offer it, with your logins. Find it in Integrations, under Browser Use.

That is the last tip. Reply and tell us what is missing. We read every answer.`,
  },
];
