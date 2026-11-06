// The email for each update of a critical issue, sent through Resend's HTTP
// API to all the issue's contacts in one call.
//
// The mail carries the whole update, so a contact need not open the page, and
// the private link to the issue page. That link is a credential: on a failure
// we log the HTTP status only, never the request body.
//
// A failed send comes back as a value, never a rejection: the update is the
// record of the promise and is already saved; the caller only reports the mail.

import type { PostedUpdate } from "../../incidents";
import { SUPPORT_EMAIL } from "./support-email";
import { zonedTime } from "./incident-time";

export const INCIDENT_MAIL_FROM = "Isomux <status@isomux.com>";

const RESEND_URL = "https://api.resend.com/emails";

/** A hung Resend call must not hold the post open after the update
 * committed: a caller who gives up and posts again makes a second update. */
export const MAIL_TIMEOUT_MS = 15_000;

/** sent, failed, or not_configured (no Resend key in this deployment). */
export type IncidentMailOutcome = "sent" | "failed" | "not_configured";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The subject: what kind, which issue, which update. */
function subjectOf(posted: PostedUpdate): string {
  const kind = posted.kind === "security" ? "Security issue" : "Critical issue";
  const which = posted.update.final ? "resolved" : `update ${posted.update.n}`;
  return `[${kind}] ${posted.title} - ${which}`;
}

/** The update as labelled lines, the same in the text and the html part and
 * as on the status page. */
function sections(posted: PostedUpdate): [string, string][] {
  const { update } = posted;
  const out: [string, string][] = [
    ["What we found", update.found],
    [update.final ? "What we did" : "What we are doing now", update.doingNow],
  ];
  if (update.estimateAt !== null) {
    out.push([
      "Estimate: resolved by",
      zonedTime(update.estimateAt, posted.timeZone),
    ]);
  }
  return out;
}

export async function sendIncidentUpdateMail(
  posted: PostedUpdate,
  issueUrl: string,
  deps: { apiKey: string | undefined; fetch?: typeof fetch },
): Promise<IncidentMailOutcome> {
  if (!deps.apiKey) return "not_configured";
  const post = deps.fetch ?? globalThis.fetch;
  const parts = sections(posted);
  const text =
    `${posted.customerLabel}: ${posted.title}\n\n` +
    parts.map(([label, value]) => `${label}:\n${value}`).join("\n\n") +
    `\n\nThe status page for this issue:\n${issueUrl}\n`;
  const html =
    `<p><strong>${escapeHtml(posted.customerLabel)}: ${escapeHtml(posted.title)}</strong></p>` +
    parts
      .map(
        ([label, value]) =>
          `<p><strong>${escapeHtml(label)}</strong><br>${escapeHtml(value).replace(/\n/g, "<br>")}</p>`,
      )
      .join("") +
    `<p>The status page for this issue:<br><a href="${escapeHtml(issueUrl)}">${escapeHtml(issueUrl)}</a></p>`;
  try {
    const response = await post(RESEND_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: INCIDENT_MAIL_FROM,
        to: posted.contacts,
        reply_to: SUPPORT_EMAIL,
        subject: subjectOf(posted),
        text,
        html,
      }),
      signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
    });
    if (response.ok) return "sent";
    // The status only: Resend's error body can quote the request, which holds
    // the private link and the contacts.
    console.error(`incident mail: Resend answered ${response.status}`);
    return "failed";
  } catch {
    // A timeout comes here too.
    console.error("incident mail: the mail request failed");
    return "failed";
  }
}
