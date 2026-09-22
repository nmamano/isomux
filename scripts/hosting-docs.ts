import { readFileSync } from "node:fs";

// One identity per complete guide. Fragments never become pages. AWS remains
// readable on GitHub at its sole maintained source as well as on the docs site.
export const HOSTING_GUIDES = [
  {
    id: "hosted",
    label: "Hosted Isomux",
    detail: "A paid Isomux hosting service by the creator of Isomux",
    source: "docs/hosting/hosted.md",
  },
  {
    id: "render",
    label: "Render",
    detail: "A paid container service",
    source: "docs/hosting/render.md",
    notice:
      "Deployment validation is incomplete. Render charges for the compute plan and persistent disk.",
  },
  {
    id: "aws",
    label: "AWS EC2 container",
    detail: "An Ubuntu server in your AWS account",
    source: "deploy/container/README.md",
  },
  {
    id: "vps",
    label: "A VPS provider such as Hetzner",
    detail: "Your cloud server and domain",
    source: "docs/hosting/vps.md",
  },
  {
    id: "local",
    label: "Host locally",
    detail: "An office on this computer",
    source: "docs/hosting/local.md",
  },
  {
    id: "private",
    label: "Private Tailscale",
    detail: "Your Linux computer, private HTTPS",
    source: "docs/hosting/private.md",
  },
  {
    id: "funnel",
    label: "Public Tailscale Funnel",
    detail: "Your Linux computer, no domain needed",
    source: "docs/hosting/funnel.md",
  },
  {
    id: "domain",
    label: "Your computer and domain",
    detail: "Your Linux computer, public HTTPS and app addresses",
    source: "docs/hosting/domain.md",
  },
] as const;

export type HostingId = (typeof HOSTING_GUIDES)[number]["id"];
export const hostingUrl = (id: HostingId) => `/docs/hosting-${id}`;

const BLOCKS = [
  "install",
  "claim",
  "provider",
  "service",
  "tailscale-install",
  "remote-signin",
  "invites",
  "manual-operations",
  "host-update",
  "backup",
];
export function composeHostingSource(source: string): string {
  return source.replace(
    /<!-- include: ([\w-]+) -->/g,
    (_marker, name: string) => {
      if (!BLOCKS.includes(name))
        throw new Error(`Unknown hosting block: ${name}`);
      const block = readFileSync(
        `docs/hosting/blocks/${name}.md`,
        "utf8",
      ).trim();
      if (block.includes("<!-- include:"))
        throw new Error(`Nested hosting block: ${name}`);
      return block;
    },
  );
}

export function hostingBody(guide: (typeof HOSTING_GUIDES)[number]): string {
  let raw = composeHostingSource(readFileSync(guide.source, "utf8"));
  // The README's relative reference works on GitHub; the generated page must
  // keep that link pointed at the same source, not /docs/reference.
  if (guide.id === "aws")
    raw = raw.replaceAll(
      "](reference.md)",
      "](https://github.com/nmamano/isomux/blob/main/deploy/container/reference.md)",
    );
  if ("notice" in guide)
    raw = raw.replace(/^(# .+\n)/, `$1\n> ${guide.notice}\n`);
  return raw;
}

function escape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
}
function guideLink(
  id: HostingId,
  current?: HostingId,
  connectionLabel?: string,
): string {
  const guide = HOSTING_GUIDES.find((g) => g.id === id)!;
  return `<a href="${hostingUrl(id)}" data-guide="${id}"${id === current ? ' aria-current="page"' : ""}><strong>${escape(connectionLabel ?? guide.label)}</strong>${connectionLabel ? "" : `<span class="hosting-detail">${escape(guide.detail)}</span>`}<svg class="hosting-link-arrow" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 12h14M13 6l6 6-6 6"/></svg></a>`;
}

export function hostingNavigation(current?: HostingId): string {
  const selected = HOSTING_GUIDES.find((g) => g.id === current);
  if (selected)
    return `<p class="hosting-guide-notice">This is the ${escape(selected.label)} guide. To check if this is the right hosting setup for you, check the <a href="/docs/hosting">decision diagram</a>.</p>`;
  return `<section class="hosting-picker" id="choose-a-setup" aria-label="Hosting decision diagram">
<div class="hosting-flow">
<p class="flow-question flow-start">Do you want multi-device or multi-user features, or agents that don't stop working when this device is off?</p>
<div class="flow-row flow-first">
<div class="flow-branch"><div class="flow-edge"><span>No</span></div>${guideLink("local", current)}</div>
<div class="flow-branch"><div class="flow-edge"><span>Yes</span></div><p class="flow-question">That requires an always-on server. Do you want to set up and manage the server?</p></div>
</div>
<div class="flow-row">
<div class="flow-branch"><div class="flow-edge"><span>No</span></div>${guideLink("hosted", current)}</div>
<div class="flow-branch"><div class="flow-edge"><span>Yes</span></div><p class="flow-question">Do you already have a computer or server to use?</p></div>
</div>
<div class="flow-row">
<div class="flow-branch"><div class="flow-edge"><span>No</span></div>
<p class="flow-question">Where do you want to rent hosting?</p>
<div class="flow-leaves">
<div class="flow-leaf">${guideLink("render", current)}</div>
<div class="flow-leaf">${guideLink("aws", current)}</div>
<div class="flow-leaf">${guideLink("vps", current)}</div>
</div></div>
<div class="flow-branch"><div class="flow-edge"><span>Yes</span></div>
<p class="flow-question">Do you own a domain you want to use for the office?<span class="flow-note">The computer or server must remain on.</span><span class="flow-note">All three options require office sign-in.</span></p>
<div class="flow-leaves">
<div class="flow-leaf"><span class="flow-answer">Yes</span>${guideLink("domain", current, "Server with a domain")}</div>
<div class="flow-leaf"><span class="flow-answer">No</span>
<p class="flow-question">Will every user and device be in the same Tailscale network?</p>
<div class="flow-leaves">
<div class="flow-leaf"><span class="flow-answer">Yes</span>${guideLink("private", current, "Tailscale")}</div>
<div class="flow-leaf"><span class="flow-answer">No</span>${guideLink("funnel", current, "Tailscale Funnel")}</div>
</div></div>
</div></div>
</div>
</div></section>`;
}

export function hostingNavigationMarkdown(): string {
  return `## Hosting decision diagram\n\nDo you want multi-device or multi-user features, or agents that don't stop working when this device is off?

- No: [Host locally](${hostingUrl("local")}).
- Yes: That requires an always-on server. Do you want to set up and manage the server?
  - No: [Hosted Isomux](${hostingUrl("hosted")}). A paid Isomux hosting service by the creator of Isomux.
  - Yes: Do you already have a computer or server to use?
    - Yes: The computer or server must remain on. All three options require office sign-in. Do you own a domain you want to use for the office?
      - Yes: [Server with a domain](${hostingUrl("domain")}).
      - No: Will every user and device be in the same Tailscale network?
        - Yes: [Tailscale](${hostingUrl("private")}).
        - No: [Tailscale Funnel](${hostingUrl("funnel")}).
    - No: Where do you want to rent hosting? Choose [Render](${hostingUrl("render")}), [AWS EC2 container](${hostingUrl("aws")}), or [A VPS provider such as Hetzner](${hostingUrl("vps")}).\n`;
}

// Preserve incoming links from README, feature docs, old pages, and bookmarks.
// These destinations are also real links in the no-JS page and agent Markdown.
export const HOSTING_LEGACY_LINKS: Record<string, string> = {
  "self-hosted-setup": "/docs/hosting#choose-a-setup",
  "vps-install": hostingUrl("vps"),
  "run-the-installer": `${hostingUrl("vps")}#run-the-installer`,
  "what-the-installer-does": "/docs/hosting-reference#what-the-installer-does",
  "root-access": "/docs/hosting-reference#root-access",
  parameters: "/docs/hosting-reference#parameters",
  "re-running": `${hostingUrl("vps")}#re-run-after-an-installation-failure`,
  updating: `${hostingUrl("vps")}#update-the-office`,
  "app-hostnames": "/docs/hosting-reference#app-hostnames",
  "opening-an-agents-dev-server": `${hostingUrl("vps")}#opening-an-agents-dev-server`,
  notes: `${hostingUrl("vps")}#installer-notes`,
  "desktop-chrome-extension":
    "/docs/hosting-reference#desktop-chrome-extension",
  "your-own-hardware": hostingUrl("private"),
  "native-build-recovery": "/docs/hosting-reference#native-build-recovery",
  "keep-the-server-running": `${hostingUrl("private")}#keep-the-office-running`,
  "make-the-office-reachable": "/docs/hosting#choose-a-setup",
  "your-devices-and-anyone-willing-to-install-tailscale": hostingUrl("private"),
  "other-members-public-url": hostingUrl("funnel"),
  "install-on-mobile-pwa": `${hostingUrl("private")}#add-people-and-devices`,
  "enable-https-for-voice-input-and-android-pwa-install": `${hostingUrl("private")}#give-the-office-a-private-https-address`,
  "authorize-members": `${hostingUrl("private")}#create-the-first-owner`,
  "provider-api-keys": "/docs/hosting-reference#provider-api-keys",
  "deploy-a-container": hostingUrl("aws"),
  "deploy-on-render": hostingUrl("render"),
  backups: `${hostingUrl("vps")}#backups`,
  "running-out-of-memory": "/docs/hosting-reference#running-out-of-memory",
  "what-each-deployment-covers":
    "/docs/hosting-reference#what-each-deployment-covers",
  "proxy-and-real-domain": "/docs/hosting-reference#proxy-and-real-domain",
  "proxy-and-no-real-domain":
    "/docs/hosting-reference#proxy-and-no-real-domain",
  "no-proxy-and-no-real-domain":
    "/docs/hosting-reference#no-proxy-and-no-real-domain",
};

export function legacyHostingHtml(): string {
  return `<details class="hosting-legacy"><summary>Links from the previous hosting guide</summary><ul>${Object.entries(
    HOSTING_LEGACY_LINKS,
  )
    .map(
      ([id, href]) =>
        `<li id="${id}"><a href="${href}">${escape(id.replaceAll("-", " "))}</a></li>`,
    )
    .join("")}</ul></details>
<script id="hosting-legacy-map" type="application/json">${JSON.stringify(HOSTING_LEGACY_LINKS)}</script>
<script src="/hosting-links.js" defer></script>`;
}
export function legacyHostingMarkdown(): string {
  return (
    "\n## Previous section links\n\n" +
    Object.entries(HOSTING_LEGACY_LINKS)
      .map(([id, href]) => `- [${id}](${href})`)
      .join("\n") +
    "\n"
  );
}
