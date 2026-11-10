// The welcome series: what each mail says. English only, plain text.
//
// Draft 2 (2026-11-08), on the five topics Nil chose. The mails speak as Nil,
// in the first person (2026-11-10). All five are his final copy (mail 1
// links the Add to Home Screen picture on isomux.com/hosted-welcome, and mail
// 5 links that page).
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
 * mail 1 goes out while he edits the rest; he approved mails 2-4 the same
 * day and mail 5 on 2026-11-11).
 * Only these send and show on isomux.com/hosted-welcome; a series waits at
 * the first mail past them, with no skip, and goes on when this number grows.
 * Shipping the next mail is its final copy below plus one here.
 */
export const WELCOME_MAILS_APPROVED = 5;

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
    subject: "Bring your collaborators in",
    body: `Isomux shines when you lean into the multiplayer aspects. When I work on a project with someone, I create a room for the project and invite them.

I also add friends and family with no previous experience with agents. It's my favorite way of showing them what AI can do for them. I found that even non-technical people will embrace it!

To bring someone in: Settings → Members → New member. Choose which rooms they see and send them the sign-in link.

{officeUrl}

Nil`,
  },
  {
    subject: "Agent collaboration",
    body: `Isomux agents can discover and message each other.

For software development, I like to use the /pair-programming built-in skill to pair two agents up. For example, Claude builds and Codex reviews.

You may have also noticed that each Isomux room also has a hatch that leads to a basement. That's where I keep the agents I never talk to.

I like to keep a project's "Lead Agent" in the front room. When it has work to hand out, it dispatches it to workers in the basement. This way, the Lead Agent stays available for me and its context stays clear of implementation details.

{officeUrl}

Nil`,
  },
  {
    subject: "Your own app store",
    body: `My agents have built dozens of apps for me. Like Isomux, they work 24/7 and can be opened from any device, behind the office's sign-in.

What makes these apps powerful is that they're integrated with the agents. Here are a couple of examples, for inspiration.

One of my apps is a monitoring dashboard for Hosted Isomux. Every 30 minutes, it checks all my systems. If anything looks off, the app tells one of my agents to look into it right away. This helps me be on top of things as a one-person company.

Another app is a daily video pipeline for the Wall Game's YouTube channel (https://www.youtube.com/@wallgameio). An agent cuts game clips into videos and queues them in the app. I watch them in the app and sign off or give feedback. Feedback goes back to the agent, while signed-off videos get posted to social media by the app itself. It even shows me view counts.

Every app shows in the Apps tab, like your own app store. Members who share a room share its apps, and you can install an app on your phone's Home Screen as its own app, just like Isomux.

{officeUrl}

Nil`,
  },
  {
    subject: "One Inbox for every decision",
    body: `When agents need you (a decision, an answer, a step only you can take), they open an ask in your Inbox instead of waiting in a chat.

I built the Inbox because I run all my projects from my Isomux office, and things were falling through the cracks. Now, I ask my agents to send everything they need from me there; I call it the "Decision Feed". For urgent asks, agents even send me notifications.

That's the last tip! You can find them all at https://isomux.com/hosted-welcome.

If you still have questions, reply here. I'd love to hear your first impressions of Isomux!

{officeUrl}

Nil`,
  },
];
