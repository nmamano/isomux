// The welcome series: what each mail says. English only, plain text.
//
// Draft 2 (2026-11-08), on the five topics Nil chose. The mails speak as Nil,
// in the first person (2026-11-10). Mail 1 is his final copy and links the Add
// to Home Screen picture on isomux.com/hosted-welcome; mails 2-5 are drafts he
// is still editing, so they neither send nor show (WELCOME_MAILS_APPROVED).
// The copy cannot depend on what the customer did in the office, because
// after setup we have no access to it.
//
// No promotion: no upgrade, plan or price pitch, no offer. The mails carry no
// postal address because, under CAN-SPAM, mail about a service the customer
// already bought is transactional or relationship mail. That holds only while
// they promote nothing.
//
// {officeUrl} is replaced with the office address, {dashboardUrl} with the
// customer dashboard. Any other {name} stops the send. The unsubscribe line is
// added by welcome-mail.ts, not written here. The site build also publishes
// the approved mails at isomux.com/hosted-welcome
// (scripts/hosted-welcome-page.ts), so a change here changes that page too.

/**
 * How many mails, from the first, have copy Nil approved (Nil, 2026-11-10:
 * mail 1 goes out while he edits the rest). Only these send and show on
 * isomux.com/hosted-welcome; a series waits at the first mail past them,
 * with no skip, and goes on when this number grows. Shipping the next mail is
 * its final copy below plus one here.
 */
export const WELCOME_MAILS_APPROVED = 1;

/** The line a late first mail opens with: the office went live before the
 * series sent anything (WELCOME_MAIL_LATE_MS). A placeholder until Nil picks
 * the words. */
export const WELCOME_MAIL_LATE_NOTE =
  "We just started sending these welcome emails, so this one comes after your office went live. I still wanted you to have it.";

export interface WelcomeMailCopy {
  subject: string;
  body: string;
}

/** One entry per step, in the order of WELCOME_MAIL_OFFSETS_MS. */
export const WELCOME_MAILS: readonly WelcomeMailCopy[] = [
  {
    subject: "Your Isomux office is ready",
    body: `Your office is up at {officeUrl}.

To sign in the first time, get your owner invite from your dashboard at {dashboardUrl} and open it in the browser where you will use the office.

I set up your office so three welcome agents are waiting for you: one each for Claude, Codex and OpenCode. The OpenCode one runs on a free model, so you can talk to it right away. The others will walk you through connecting your subscriptions when you first message them.

One advantage of running your office on your own private virtual server is that you can connect from any of your devices. I especially like to check in from my phone.

To add your phone: in the office, Settings → Sign-in links → Generate device link. Send the link to yourself and open it on your phone. For the native app feel, you can "install" the website as an app. On iPhone, open the Share menu in the browser and "Add to Home Screen" (here's what it looks like: https://isomux.com/hosted-welcome#home-screen). On Android, Chrome offers to install it.

Over the next two weeks, I'll send you a few short tips. Reply to any of them if something does not work; I'll read every email and make sure to improve Isomux.

Thank you!
Nil`,
  },
  {
    subject: "Bring your team in",
    body: `To bring someone in, open Settings, then Members, select New member at the end of the list, and send them their sign-in link. You choose which rooms they see.

They talk to the same agents and see the same conversations, live. Members also have their own chat in the lobby.

{officeUrl}

Nil`,
  },
  {
    subject: "Front room, back room",
    body: `Each room has a front with eight desks for the agents you talk to, and a back room behind the trap door for up to 100 more.

A pattern I use all the time: talk to one agent in the front. When it has work to hand out, it starts workers in the back room, messages them, and reports back to you. You can still open any worker and follow its work.

Agents can also message each other and read each other's conversations, so one agent can review another's work.

{officeUrl}

Nil`,
  },
  {
    subject: "Apps, and your own app store",
    body: `Ask an agent to build you a small web app: a tracker, a dashboard, a form. It runs in your office, behind your sign-in, and opens from any device.

Every app shows in the Apps tab, your own app store. Members who share a room share its apps, and you can install an app on your phone's Home Screen as its own app.

{officeUrl}

Nil`,
  },
  {
    subject: "One Inbox for every decision",
    body: `When an agent needs you (a decision, an answer, a step only you can take), it opens an ask in your Inbox instead of waiting in a chat. Each ask says what to decide, the options and the agent's pick. You answer with one tap, from your phone or your desk.

Ask your agents to send everything they need from you there, and you run the whole office from one feed of decisions. An urgent ask rings through your notifications until you answer it.

That's the last tip. Reply and tell me what is missing. I read every answer.

Nil`,
  },
];
