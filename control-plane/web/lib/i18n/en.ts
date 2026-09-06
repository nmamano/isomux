// The English catalog: the typed source of truth for this app's copy
// (internal-docs/i18n-loop.md, ruling 7). `es.ts` and `ca.ts` are complete
// records over these keys, so a missing translation is a compile error.
//
// Moving a string in here never changes it (ruling 6). Product names, plan
// names, hostnames, SSH commands, ISO dates and Stripe's own status words are
// not copy and are not here (ruling 11).
//
// A `<tag>...</tag>` pair marks a span the caller wraps in an element, and is
// read only through rich() (ruling 16): one key per sentence, because word
// order differs per language. `{name}` is a value the caller supplies.

export const en = {
  // ------------------------------------------------------------- shared
  "common.signOut": "Sign out",
  "common.backToOffices": "Your offices",
  "common.continueToPayment": "Continue to payment",
  "common.openOfficeAndSignIn": "Open your office and sign in",

  // ------------------------------------------------------------- language switch
  "language.label": "Language",

  // ------------------------------------------------------------- landing
  "home.signedOutLead": "<signin>Sign in</signin> to set up an office.",
  "home.signedInAs": "Signed in as {email}",
  "home.officeHeading": "Your office",
  "home.ready": "ready",
  "home.notReady": "not ready yet",
  "home.viewOffice": "View office",
  "home.setUpAnother": "<link>Set up another office</link>.",
  "home.noOffice": "You have no office yet. <link>Set one up</link>.",

  // ------------------------------------------------------------- sign in
  "signIn.heading": "Sign in",
  "signIn.google": "Continue with Google",

  // ------------------------------------------------------------- sign up
  "signup.heading": "Set up your office",
  "signup.continue": "Continue signup",
  "signup.officeName": "Office name",
  "signup.addressPreview":
    "Your office will be <name>{hostname}</name>. It cannot be changed after setup.",
  "signup.choosePlan": "Choose your office",
  "signup.planChangeNote": "Changing plans after signup is not available yet.",
  "signup.couponLabel": "Promotional code (optional)",
  "signup.couponHint": "If you received a promotional code, enter it here.",
  "signup.keyLabel": "Save your server administrator key",
  "signup.keyNote":
    "This key is for accessing your entire server, not just the Isomux office. You need it to install software as an administrator and manage or repair your server. It was generated locally in your browser and is shown only to you. Save it somewhere only you can access. We cannot create a new one after the fact because we lock ourselves out of your server after setup.",
  "signup.keyHowTo":
    "<label>How to use it:</label> This is an SSH private key. A chatbot can walk you through how to use it to access your server through a terminal, or an agent running locally on your computer can use it to access the server for you.",
  "signup.keyHidden": "Private key hidden",
  "signup.keyHide": "Hide private key",
  "signup.keyReveal": "Reveal private key",
  "signup.keyCopy": "Copy private key",
  "signup.keyCopied": "Copied",
  "signup.keyDownload": "Download private key",
  "signup.keySaved": "I saved it",
  "signup.saveKeyReason": "Save your server administrator key before continuing.",
  "signup.cryptoError":
    "Your browser cannot create or copy the server administrator key on this page. Open the signup page over HTTPS in a current browser and try again.",
  "signup.clipboardError":
    "Your browser could not copy the server administrator key. Reveal the key and select it from the field instead.",
  "signup.checkoutError":
    "We could not open a payment page just now. Try again in a moment.",
  "signup.refusedError":
    "We could not continue signup. Reload the page and try again.",

  // ------------------------------------------------------------- policy notice
  "policy.notice":
    "Before you pay, review the <terms>Terms of Service</terms>, <privacy>Privacy Policy</privacy>, and <refund>Refund Policy</refund>.",

  // ------------------------------------------------------------- plan price
  "plan.priceLine": "{amount} per {period}",
  "plan.period.month": "month",

  // ------------------------------------------------------------- progress steps
  "steps.labelWaitingForPayment": "Waiting for payment",
  "steps.labelCreateInstance": "Ordering your server",
  "steps.labelWaitForAddress": "Waiting for the server address",
  "steps.labelWaitForSsh": "Waiting for the server to answer",
  "steps.labelFirstContact": "Securing our temporary access",
  "steps.labelInstallCustomerKey": "Installing your SSH key",
  "steps.labelArmRevocation": "Setting a timer for our access to expire",
  "steps.labelWaitForPackageManager": "Waiting for the server's package manager",
  "steps.labelSetDns": "Setting your office's address",
  "steps.labelRunInstaller": "Installing isomux",
  "steps.labelVerifyHttps": "Checking your office over HTTPS",
  "steps.labelMintInvite": "Preparing your owner invite",
  "steps.labelRevokeAccess": "Removing our access",
  "steps.labelPowerOff": "Suspending the office",
  "steps.labelReboot": "Restarting your server",
  "steps.labelPowerOn": "Bringing your office back",
  "steps.labelExpireCheckout": "Closing an unfinished reinstatement payment",
  "steps.labelCancelAsset": "Cancelling your server with the provider",
  "steps.labelRemoveDns": "Removing your office's address",

  "stepState.waiting": "not started",
  "stepState.active": "in progress",
  "stepState.checking": "checking",
  "stepState.done": "done",
  "stepState.failed": "failed",

  // ------------------------------------------------------------- durations
  "office.duration.hours.one": "{count} hour",
  "office.duration.hours.other": "{count} hours",
  "office.duration.minutes.one": "{count} minute",
  "office.duration.minutes.other": "{count} minutes",
  "office.duration.seconds.one": "{count} second",
  "office.duration.seconds.other": "{count} seconds",
  "office.runningFor": "running for {spoken}",
  "office.took": ", took {spoken}",

  // ------------------------------------------------------------- office page
  "office.navLabel": "Office navigation",
  "office.ready": "Your office is ready.",
  "office.notReady": "Your office is not ready yet.",
  "office.completePayment": "Complete payment to start ordering your server.",
  "office.openOffice": "Open your office",
  "office.progressHeading": "Progress",
  "office.otherWorkHeading": "Other work on this office",
  "office.gettingInHeading": "Getting in",
  "office.sshAccess": "Your SSH access: <cmd>{command}</cmd>",

  "office.attention.heading": "We need to check your setup",
  "office.attention.seen": " (we have seen it)",
  "office.attention.note":
    "You do not need to do anything. We have been notified. If this message is still here after 12 hours, email <mail>{address}</mail>.",
  "attention.labelInactivityDeadline":
    "A step is taking longer than expected. We will continue setting up your office.",
  "attention.labelAbsoluteDeadline":
    "A step has passed its time limit. We will check your setup.",
  "attention.labelOperationCondition":
    "A step needs our attention. We will check your setup.",

  "office.access.notStarted":
    "Hosted Isomux Provisioning does not have a key to your server yet.",
  "office.access.gone":
    "Hosted Isomux Provisioning no longer has a key to your server.",
  "office.access.needsAttention":
    "Hosted Isomux Provisioning cannot confirm whether it still has a key to your server.",
  "office.access.holdsUntil":
    "Hosted Isomux Provisioning holds a temporary key to your server, until {date} at the latest.",
  "office.access.holds":
    "Hosted Isomux Provisioning holds a temporary key to your server.",

  "office.invite.heading": "Get your owner invite",
  "office.invite.notYet": "Wait until the office is serving.",
  "office.invite.get": "Get my owner invite",
  "office.invite.resend": "Send me a new invite",
  "office.invite.resendCaveat":
    "A new invite replaces the previous one, which stops working.",
  "office.invite.closed":
    "Hosted Isomux Provisioning can no longer create invites for this office. If you cannot get in, contact support.",
  "office.invite.asking": "Asking for an invite...",
  "office.invite.failed": "We could not prepare an invite. Try asking again.",
  "office.invite.waiting": "Preparing your invite. This takes a few seconds.",
  "office.invite.gone": "that invite is no longer available",
  "office.invite.slow":
    "preparing your invite is taking longer than expected. Try asking again.",
  "office.invite.askFailed": "we could not ask for an invite just now.",
  "office.invite.linkNote":
    "Open this from the browser profile where you'll use the office (not incognito). It works once and is gone after five minutes; if you miss it, ask for a new one. You can add your other devices later from inside the office.",

  "office.signIn.shownOnce":
    "Your link was shown once and is not kept. Ask for a new one above if you still need to sign in.",
  "office.signIn.adopted":
    "Open your office above and make sure it works in this browser.",
  "office.signIn.pending":
    "Your sign-in link will appear here after the invite is ready.",

  "office.handoff.heading": "Confirm office access, then remove our access",
  "office.handoff.warning":
    "Do not continue until your office is open in this browser. After removal, Hosted Isomux Provisioning cannot create another owner invite for you.",
  "office.handoff.confirm":
    "Click to confirm that your office is open in this browser.",
  "office.handoff.inviteRequired":
    "Get your owner invite and open your office before you confirm.",
  "office.handoff.remove": "Remove Hosted Isomux Provisioning access",
  "office.handoff.removing": "Removing temporary access...",
  "office.handoff.pending":
    "Your request was received. We are removing our temporary access now.",
  "office.handoff.failedLower": "we could not remove our access just now.",
  "office.handoff.failed": "We could not remove our access just now.",

  "office.revocation.heading": "Access removal",
  "office.revocation.done":
    "Hosted Isomux Provisioning no longer has a key to your server. We confirmed this by trying to reconnect with it and being refused.",
  "office.revocation.failed":
    "We could not remove our key, and a person has been asked to finish it. Your server's own expiry still removes it at the latest date shown above.",
  "office.revocation.checking":
    "We are removing our key and could not confirm it yet. A person has been asked to check. Your server's own expiry still removes it at the latest date shown above.",
  "office.revocation.removing": "We are removing our key from your server.",

  "office.livenessHeading": "Is it answering?",
  "office.liveness.unreachable":
    "Your office has not answered its last {strikes} checks: {words}. This has been raised with us.",
  "office.liveness.strike": "The last check did not get through: {words}.",
  "office.liveness.ok": "Checked just now: {words}.",
  "liveness.labelDns": "waiting for the name to resolve",
  "liveness.labelWrongBox": "the name points somewhere else",
  "liveness.labelTcp": "waiting for the office to accept connections",
  "liveness.labelTls": "waiting for the certificate",
  "liveness.labelReadyz": "waiting for the office to report ready",
  "liveness.labelOk": "the office is serving",

  "office.restartHeading": "Restart",
  "office.restartCaveat":
    "Restarting powers the whole server off and on, not just isomux. It interrupts every agent that is running and takes a couple of minutes.",
  "office.restart": "Restart my server",
  "office.restarting": "Restarting...",
  "office.action.restartServer": "restart your server",
  "office.action.failedLower": "we could not {action} just now.",
  "office.action.failed": "We could not {action} just now.",

  "office.planHeading": "Your plan",
  "office.plan.waitingForPayment": "waiting for payment to be confirmed",
  "office.plan.noCharge": ", no charge",
  "office.plan.periodEnds": "period ends {date}",
  "office.plan.nextInvoice": "next invoice {date}",

  "office.cancel.pendingCancel":
    "We have asked Stripe to cancel your subscription. This page updates when Stripe confirms it.",
  "office.cancel.pendingUncancel":
    "We have asked Stripe to keep your subscription. This page updates when Stripe confirms it.",
  "office.cancel.ended": "This office has been deleted.",
  "office.cancel.reinstatePending":
    "Your office remains powered off while payment is pending. Complete payment before {deadline} to reinstate this same office.",
  "office.cancel.reinstateExpired":
    "The reinstatement deadline has been reached. This payment can no longer reinstate the office.",
  "office.cancel.suspended":
    "Your office is powered off. Restart your subscription by {date} to restore it, or contact support for free temporary access to your office so you can get your data out. After {date}, your office cannot be recovered.",
  "office.cancel.retentionEnded":
    "The retention period for this office has ended. It can no longer be recovered.",
  "office.cancel.powerOffLaunch":
    "Your subscription ended on {endedAt}. Your office is being powered off. Restart your subscription by {date} to restore it, or contact support for free temporary access to your office so you can get your data out. After {date}, your office cannot be recovered.",
  "office.cancel.restartRefusedLaunch":
    "This office cannot be restarted. Your office dashboard shows the options available now.",
  "office.cancel.grace":
    "Your subscription ended on {endedAt}. Your office keeps serving until {graceEnd} so you can take your work out. After that your server is powered off.",
  "office.cancel.restartRefused":
    "This office cannot be restarted here after suspension. Contact support if you need help.",
  "office.cancel.scheduledLaunch":
    "Your subscription is scheduled to end on {date}. Your office runs through the period you paid for and is powered off when that period ends.",
  "office.cancel.scheduledLaunchRetention":
    "We retain the server data for 14 days. During that time, restart your subscription to restore the same office, or contact support for free temporary access to your office so you can get your data out. After that, your office cannot be recovered.",
  "office.cancel.scheduled":
    "Your subscription is scheduled to end on {date}. Your office keeps serving until {date}, and then for a further 7 days until {graceEnd}.",
  "office.cancel.scheduledAfter":
    "After {graceEnd} your server is powered off. Your data stays on it for one calendar month, and then the server is permanently deleted.",
  "office.cancel.keep": "Keep my office",
  "office.cancel.keepCaveat":
    " Keeping your office means your subscription renews on {date} and normal billing continues.",
  "office.cancel.caveat":
    "Cancelling keeps your office running until the end of the period you have paid for.",
  "office.cancel.cancel": "Cancel my office",
  "office.cancel.planFailedLower": "we could not change your plan just now.",
  "office.cancel.planFailed": "We could not change your plan just now.",
  "office.reinstate.failedLower": "we could not open reinstatement payment.",
  "office.reinstate.return": "Return to payment",
  "office.reinstate.reinstate": "Reinstate this office",
  "office.refundNotice":
    "You can request a full refund by emailing {address} within 7 days of your first payment. If we refund you, we don't retain the server data for 14 days in case you want to restore it later.",

  // ------------------------------------------------------------- payment failures
  // The sentences of lib/customer-error.ts. The reference code they carry is a
  // support handle, not copy: it stays byte-identical in every language.
  "errors.reference": "Reference: {reference}.",
  "errors.checkoutReservedConfiguration":
    "We could not open a payment page. Your name is reserved.",
  "errors.paymentsConfiguration": "Payments are not available right now.",
  "errors.checkoutReservedTransient":
    "We could not open a payment page just now. Your name is reserved, so try again in a moment.",
  "errors.reinstatementTransient":
    "We could not open reinstatement payment just now. Try again in a moment.",
  "errors.billingChangeAmbiguous":
    "We could not confirm your change with our payment provider. Check back in a moment before trying again.",
  "errors.providerTransient":
    "We could not reach our payment provider just now. Try again in a moment.",
  "errors.checkoutSessionUnavailable":
    "We could not check your payment page just now - try again in a moment.",
  "errors.checkoutSessionUnsaved":
    "We could not save your payment page just now - try again in a moment.",
} as const;

export type Catalog = Readonly<Record<keyof typeof en, string>>;
export type MessageKey = keyof typeof en;
