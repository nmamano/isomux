// auto-deploy.sh, one tick at a time, against a fake docker and systemctl and a
// stub registry, GitHub API and Cloudflare API. The health probe is the real one:
// it asks the fake docker what runs and then calls a stub site on a Unix socket,
// as it calls the real site on the VPS. Nothing here touches a real registry,
// GitHub, Cloudflare or Docker. The model is nilmamano.com's
// ops/self-host/auto-deploy.test.ts.
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A tick is one bash run with a dozen curl and python3 calls: under a second, up to
// 2 s at load 13 on 8 cores (2026-10-25). No test runs more than four.
setDefaultTimeout(15_000);

const IMAGE = "ghcr.io/nmamano/isomux-site";
const REPO = "nmamano/isomux";
const ZONE = "0123456789abcdef0123456789abcdef";
const TOKEN = "stub-purge-token-7f3a";
const HOSTS = ["isomux.com", "www.isomux.com", "stage.isomux.com"];
const here = import.meta.dir;
const script = join(here, "auto-deploy.sh");

const dir = mkdtempSync(join(tmpdir(), "isd-"));
const root = join(dir, "root");
const envDir = join(dir, "etc");
const fake = join(dir, "fake");
const bin = join(fake, "bin");
const units = join(dir, "units");
const socket = join(dir, "site.sock");
for (const path of [
  root,
  bin,
  units,
  join(fake, "labels"),
  join(fake, "broken"),
])
  mkdirSync(path, { recursive: true });
mkdirSync(envDir, { mode: 0o700 });

const config = (extra = "") =>
  writeFileSync(
    join(envDir, "auto-deploy.env"),
    `ISOMUX_SITE_IMAGE=${IMAGE}\nISOMUX_SITE_GITHUB_REPO=${REPO}\nISOMUX_SITE_IMAGE_WORKFLOW=site-image.yml\nISOMUX_SITE_CF_ZONE=${ZONE}\n${extra}`,
    { mode: 0o600 },
  );
config();
writeFileSync(join(envDir, "purge-token"), `${TOKEN}\n`, { mode: 0o600 });

const hex = (n: number) => n.toString(16).padStart(2, "0");
const digest = (n: number) => "sha256:" + hex(n).repeat(32);
const commit = (n: number) => hex(n).repeat(20);
const label = (n: number) =>
  writeFileSync(join(fake, "labels", digest(n)), commit(n));
for (let n = 1; n <= 40; n++) label(n);

writeFileSync(join(root, "compose.yaml"), "services: {}\n");
writeFileSync(
  join(root, "release.env"),
  `ISOMUX_SITE_UID=990\nISOMUX_SITE_GID=990\nISOMUX_SITE_IMAGE=${IMAGE}@${digest(1)}\n`,
);
writeFileSync(join(root, "release.commit"), commit(1) + "\n");
writeFileSync(join(fake, "running"), digest(1));
writeFileSync(join(fake, "unhealthy"), "");
// The local images of this site, plus one of another project that must never be removed.
writeFileSync(
  join(fake, "images"),
  `${IMAGE}@${digest(1)}\nghcr.io/other/site@${digest(99)}\n`,
);

// docker: pull adds the image; image inspect reads the fake labels; image ls lists
// the repository's images; image rm drops one. `compose up` starts what
// release.env names and fails for a digest on the unhealthy list; `compose ps -q
// site` names the container; `inspect` of it reports its health and image.
// Every call's arguments go to fake/argv.
writeFileSync(
  join(bin, "docker"),
  `#!/usr/bin/env bash
fake=${fake}
echo "docker $*" >> "$fake/argv"
running=$(cat "$fake/running")
case $1 in
pull) grep -qx "\${3##*@}" "$fake/pull-fail" 2>/dev/null && exit 1; echo "$3" >> "$fake/images"; exit 0 ;;
image)
  case $2 in
  ls) grep "^\${@: -1}@" "$fake/images" ;;
  rm) grep -vx "$3" "$fake/images" > "$fake/images.tmp"; mv "$fake/images.tmp" "$fake/images"; echo "$3" >> "$fake/removed" ;;
  *) ref=\${@: -1}; cat "$fake/labels/\${ref##*@}" ;;
  esac ;;
compose)
  for ((i=1; i<=$#; i++)); do [[ \${!i} == --env-file ]] && { j=$((i+1)); env_file=\${!j}; }; done
  case " $* " in
  *" up "*)
    d=$(sed -n 's/^ISOMUX_SITE_IMAGE=.*@//p' "$env_file"); echo "$d" > "$fake/running"
    grep -qx "$d" "$fake/unhealthy" && exit 1; exit 0 ;;
  *" ps "*) echo cid-site ;;
  *) exit 0 ;;
  esac ;;
inspect)
  case $* in
  *Health*) grep -qx "$running" "$fake/unhealthy" && echo unhealthy || echo healthy ;;
  *Image*) echo "${IMAGE}@$running" ;;
  *) exit 1 ;;
  esac ;;
*) exit 0 ;;
esac
`,
  { mode: 0o755 },
);
writeFileSync(
  join(bin, "systemctl"),
  `#!/usr/bin/env bash\necho "systemctl $*" >> ${fake}/argv\necho "$*" >> ${fake}/systemctl\n`,
  { mode: 0o755 },
);
// curl runs for real; the wrapper records its arguments.
const realCurl = Bun.which("curl");
if (!realCurl) throw new Error("curl is required");
writeFileSync(
  join(bin, "curl"),
  `#!/usr/bin/env bash\necho "curl $*" >> ${fake}/argv\nexec ${realCurl} "$@"\n`,
  { mode: 0o755 },
);

// The stub site on the socket answers as the running digest's image would. A file
// fake/broken/<digest> names one way that image is broken.
type Breakage = "home" | "robots" | "markdown-type" | "markdown-cached";
const breakage = (): Breakage | null => {
  const running = readFileSync(join(fake, "running"), "utf8").trim();
  const file = join(fake, "broken", running);
  return existsSync(file)
    ? (readFileSync(file, "utf8").trim() as Breakage)
    : null;
};
const siteRequests: { path: string; accept: string | null }[] = [];
let site: ReturnType<typeof Bun.serve>;

// Stub registry, GitHub API and Cloudflare API. The runs endpoint answers 304 to a
// matching ETag. The purge endpoint fails `purgeFailures` times, then succeeds.
let mainDigest = digest(1);
let runStatus = "completed";
let apiFails = false;
let purgeFailures = 0;
const served = { ok: 0, notModified: 0 };
const purges: { auth?: string; body: string; ok: boolean }[] = [];
let api: Server;

beforeAll(async () => {
  site = Bun.serve({
    unix: socket,
    fetch(request) {
      const url = new URL(request.url);
      const accept = request.headers.get("accept");
      siteRequests.push({ path: url.pathname, accept });
      const broken = breakage();
      if (url.pathname === "/robots.txt")
        return new Response("User-agent: *\n", {
          status: broken === "robots" ? 404 : 200,
        });
      if (url.pathname !== "/")
        return new Response("not found", { status: 404 });
      if (broken === "home") return new Response("down", { status: 500 });
      if (accept?.includes("text/markdown"))
        return new Response("# Isomux\n", {
          headers: {
            "Content-Type":
              broken === "markdown-type"
                ? "text/html; charset=utf-8"
                : "text/markdown; charset=utf-8",
            "Cache-Control":
              broken === "markdown-cached"
                ? "public, max-age=0, s-maxage=300"
                : "no-store",
          },
        });
      return new Response("<!doctype html>", {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=0, s-maxage=300, must-revalidate",
        },
      });
    },
  });
  api = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    if (url.pathname === "/token")
      return res.end(JSON.stringify({ token: "stub" }));
    if (url.pathname === "/v2/nmamano/isomux-site/manifests/main") {
      res.writeHead(200, { "Docker-Content-Digest": mainDigest });
      return res.end();
    }
    if (
      url.pathname === `/repos/${REPO}/actions/workflows/site-image.yml/runs`
    ) {
      if (apiFails) {
        res.writeHead(500);
        return res.end();
      }
      const etag = `W/"${runStatus}"`;
      if (req.headers["if-none-match"] === etag) {
        served.notModified++;
        res.writeHead(304, { ETag: etag });
        return res.end();
      }
      served.ok++;
      res.writeHead(200, { ETag: etag, "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ workflow_runs: [{ status: runStatus }] }),
      );
    }
    if (
      url.pathname === `/zones/${ZONE}/purge_cache` &&
      req.method === "POST"
    ) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const ok = purgeFailures-- <= 0;
        purges.push({ auth: req.headers.authorization, body, ok });
        res.writeHead(ok ? 200 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: ok }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
});
afterAll(async () => {
  await site.stop(true);
  api.close();
  rmSync(dir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
type Status = {
  result: string;
  phase: string;
  deployed: string | null;
  stopped: boolean;
  waiting: boolean;
  units: string;
};
// spawnSync would block the stub servers in this process, so the tick runs
// asynchronously.
function tick(): Promise<{
  status: Status;
  output: string;
  code: number | null;
}> {
  return new Promise((done) => {
    const child = spawn("bash", [script], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        ISOMUX_SITE_ROOT: root,
        ISOMUX_SITE_ENV_DIR: envDir,
        ISOMUX_SITE_UNIT_DIR: units,
        ISOMUX_SITE_SYSTEMCTL: join(bin, "systemctl"),
        ISOMUX_SITE_DOCKER: join(bin, "docker"),
        ISOMUX_SITE_REGISTRY: base(),
        ISOMUX_SITE_GITHUB_API: base(),
        ISOMUX_SITE_CF_API: base(),
        ISOMUX_SITE_SOCKET: socket,
        ISOMUX_SITE_RETRY_SLEEP: "0",
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => {
      const file = join(root, "auto-deploy/status.json");
      const status = existsSync(file)
        ? (JSON.parse(readFileSync(file, "utf8")) as Status)
        : ({
            result: "no status.json",
            phase: "",
            deployed: null,
            stopped: false,
            waiting: false,
            units: "",
          } as Status);
      done({ status, output, code });
    });
  });
}
const lines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
    : [];
const failed = () => lines(join(root, "auto-deploy/failed"));
const images = () => lines(join(fake, "images"));
const running = () => readFileSync(join(fake, "running"), "utf8").trim();
const releaseDigest = () =>
  readFileSync(join(root, "release.env"), "utf8").match(
    /^ISOMUX_SITE_IMAGE=.*@(sha256:[0-9a-f]{64})$/m,
  )?.[1];

describe("auto-deploy.sh", () => {
  it("an unchanged main digest is up to date, and the second runs read is a 304", async () => {
    const { status, code } = await tick();
    expect(code).toBe(0);
    expect(status.result).toBe("up_to_date");
    expect(status.deployed).toBe(commit(1));
    expect(status.units).toBe("absent");
    expect(purges).toHaveLength(0);
    await tick();
    expect(served).toEqual({ ok: 1, notModified: 1 });
  });

  it("waits while an image workflow runs; a new main digest deploys and purges the site's hosts", async () => {
    runStatus = "in_progress";
    let { status } = await tick();
    expect(status.result).toBe("waiting");
    expect(status.waiting).toBe(true);
    runStatus = "completed";
    mainDigest = digest(2);
    siteRequests.length = 0;
    ({ status } = await tick());
    expect(status.result).toBe("deployed");
    expect(status.deployed).toBe(commit(2));
    expect(running()).toBe(digest(2));
    // Only the image line changes; the dedicated uid and gid stay.
    expect(readFileSync(join(root, "release.env"), "utf8")).toBe(
      `ISOMUX_SITE_UID=990\nISOMUX_SITE_GID=990\nISOMUX_SITE_IMAGE=${IMAGE}@${digest(2)}\n`,
    );
    expect(readFileSync(join(root, "release.commit"), "utf8").trim()).toBe(
      commit(2),
    );
    // The probe went through the socket: the home page, robots.txt and the
    // Markdown answer of the home page.
    expect(siteRequests.map((request) => request.path).sort()).toEqual([
      "/",
      "/",
      "/robots.txt",
    ]);
    expect(
      siteRequests.some((request) => request.accept?.includes("text/markdown")),
    ).toBe(true);
    // The zone also holds other names (cloud.isomux.com): purge by host, never everything.
    expect(purges).toHaveLength(1);
    expect(purges[0].auth).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(purges[0].body) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["hosts"]);
    expect((body.hosts as string[]).slice().sort()).toEqual(
      HOSTS.slice().sort(),
    );
  });

  it("never puts the purge token in a command line", async () => {
    expect(purges.length).toBeGreaterThan(0);
    const argv = readFileSync(join(fake, "argv"), "utf8");
    expect(argv).toContain(`/zones/${ZONE}/purge_cache`);
    expect(argv.includes(TOKEN)).toBe(false);
  });

  it("keeps only the running image and the rollback image, and never another project's", async () => {
    mainDigest = digest(3);
    const { status } = await tick();
    expect(status.result).toBe("deployed");
    expect(images().sort()).toEqual(
      [
        `${IMAGE}@${digest(2)}`,
        `${IMAGE}@${digest(3)}`,
        `ghcr.io/other/site@${digest(99)}`,
      ].sort(),
    );
    expect(lines(join(fake, "removed"))).toEqual([`${IMAGE}@${digest(1)}`]);
  });

  it("retries a failed purge, logs it, and keeps the deploy", async () => {
    purgeFailures = 5;
    let before = purges.length;
    mainDigest = digest(4);
    let { status, output } = await tick();
    expect(status.result).toBe("deployed");
    expect(status.deployed).toBe(commit(4));
    expect(purges.length - before).toBe(3);
    expect(output).toMatch(/purge.*fail|fail.*purge/i);
    purgeFailures = 1;
    before = purges.length;
    mainDigest = digest(5);
    ({ status, output } = await tick());
    expect(status.result).toBe("deployed");
    expect(purges.slice(before).map((purge) => purge.ok)).toEqual([
      false,
      true,
    ]);
  });

  it("rolls back an image that does not run healthy, purges, and does not try it again", async () => {
    writeFileSync(join(fake, "unhealthy"), digest(6) + "\n");
    mainDigest = digest(6);
    const before = purges.length;
    let { status } = await tick();
    expect(status.result).toBe("rolled_back");
    expect(status.deployed).toBe(commit(5));
    expect(running()).toBe(digest(5));
    expect(releaseDigest()).toBe(digest(5));
    expect(failed()).toEqual([digest(6)]);
    expect(purges.length - before).toBe(1);
    ({ status } = await tick());
    expect(status.result).toBe("failed_target");
    expect(running()).toBe(digest(5));
  });

  // Docker calls each of these images healthy; only the probe through the socket
  // sees the fault.
  const faults: [Breakage, number][] = [
    ["home", 7],
    ["robots", 8],
    ["markdown-type", 9],
    ["markdown-cached", 10],
  ];
  for (const [fault, n] of faults)
    it(`rolls back an image whose socket answer fails the probe: ${fault}`, async () => {
      writeFileSync(join(fake, "broken", digest(n)), fault);
      mainDigest = digest(n);
      const { status } = await tick();
      expect(status.result).toBe("rolled_back");
      expect(status.deployed).toBe(commit(5));
      expect(running()).toBe(digest(5));
      expect(failed()).toContain(digest(n));
    });

  it("marks a digest failed after three failed pulls", async () => {
    writeFileSync(join(fake, "pull-fail"), digest(11) + "\n");
    mainDigest = digest(11);
    const results: string[] = [];
    for (let i = 0; i < 4; i++) results.push((await tick()).status.result);
    expect(results).toEqual([
      "build_failed",
      "build_failed",
      "failed",
      "failed_target",
    ]);
    expect(failed()).toContain(digest(11));
    expect(running()).toBe(digest(5));
  });

  it("deploys without a purge when no zone is set", async () => {
    writeFileSync(
      join(envDir, "auto-deploy.env"),
      `ISOMUX_SITE_IMAGE=${IMAGE}\nISOMUX_SITE_GITHUB_REPO=${REPO}\nISOMUX_SITE_IMAGE_WORKFLOW=site-image.yml\n`,
      { mode: 0o600 },
    );
    mainDigest = digest(12);
    const before = purges.length;
    const { status } = await tick();
    expect(status.result).toBe("deployed");
    expect(status.deployed).toBe(commit(12));
    expect(purges.length).toBe(before);
    config();
  });

  it("installs this directory's unit files when the installed copies differ", async () => {
    for (const name of [
      "isomux-site-autodeploy.service",
      "isomux-site-autodeploy.timer",
    ])
      writeFileSync(join(units, name), "# an older copy\n");
    rmSync(join(fake, "systemctl"), { force: true });
    const { status } = await tick();
    expect(status.units).toBe("ok");
    for (const name of [
      "isomux-site-autodeploy.service",
      "isomux-site-autodeploy.timer",
    ])
      expect(readFileSync(join(units, name), "utf8")).toBe(
        readFileSync(join(here, name), "utf8"),
      );
    expect(lines(join(fake, "systemctl"))).toEqual([
      "daemon-reload",
      "restart isomux-site-autodeploy.timer",
    ]);
    // Equal copies: no reload.
    await tick();
    expect(lines(join(fake, "systemctl"))).toHaveLength(2);
  });

  it("deploys nothing on an API error or a hold, and deploys once they clear", async () => {
    mainDigest = digest(13);
    apiFails = true;
    let { status } = await tick();
    expect(status.result).toBe("tick_error");
    apiFails = false;
    writeFileSync(join(envDir, "auto-deploy.hold"), "");
    ({ status } = await tick());
    expect(status.result).toBe("held");
    expect(running()).toBe(digest(12));
    rmSync(join(envDir, "auto-deploy.hold"));
    ({ status } = await tick());
    expect(status.result).toBe("deployed");
    expect(running()).toBe(digest(13));
  });

  it("deploys nothing while another tick holds the lock or the config is unsafe", async () => {
    mainDigest = digest(15);
    const holder = spawn("flock", [join(root, "deploy.lock"), "sleep", "1"]);
    const released = new Promise((done) => holder.on("close", done));
    await Bun.sleep(300);
    let { status } = await tick();
    expect(status.result).toBe("locked");
    await released;
    chmodSync(join(envDir, "auto-deploy.env"), 0o644);
    ({ status } = await tick());
    expect(status.phase).toBe("config");
    chmodSync(join(envDir, "auto-deploy.env"), 0o600);
    config("ISOMUX_SITE_CF_ZONE=not-a-zone\n");
    ({ status } = await tick());
    expect(status.phase).toBe("config");
    config();
    expect(running()).toBe(digest(13));
  });

  it("stops every later tick after a failed rollback", async () => {
    mainDigest = digest(14);
    // The new image fails, and the previous one no longer runs healthy either.
    writeFileSync(
      join(fake, "unhealthy"),
      [digest(14), digest(13)].join("\n") + "\n",
    );
    let { status } = await tick();
    expect(status.result).toBe("rollback_failed");
    expect(status.stopped).toBe(true);
    ({ status } = await tick());
    expect(status.result).toBe("stopped");
  });
});
