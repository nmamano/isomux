// Which candidate commit has a green Build on main, read from GitHub's public
// API without a token. auto-deploy.sh runs it inside the deployed provisioner
// image, so the host needs no JavaScript runtime. Node built-ins only.
//
//   bun build-runs.ts <api base> <owner/repo> <sha>...   (newest first)
//
// Prints the first given sha whose Build is green, or `none`. Green: the newest
// run (highest run_number) of build.yml for a push to main with that head_sha
// is completed with conclusion success; the API reports a rerun's latest
// attempt. It reads at most three pages of 100 runs, newest first; a candidate
// whose run is not among them counts as not green.
//
// Exit 1 on a failed request, a status other than 200, or an answer that does
// not have the expected shape. Nothing is printed to stdout then.

const PAGES = 3;
const PER_PAGE = 100;
const TIMEOUT_MS = 20_000;

interface Run {
  sha: string;
  number: number;
  green: boolean;
}

function fail(message: string): never {
  console.error(`build-runs: ${message}`);
  process.exit(1);
}

function runsOf(body: unknown): Run[] {
  const list = (body as { workflow_runs?: unknown })?.workflow_runs;
  if (!Array.isArray(list)) fail("the answer has no workflow_runs list");
  return list.map((raw: unknown) => {
    const run = raw as Record<string, unknown>;
    const sha = run.head_sha;
    const number = run.run_number;
    const { status, conclusion } = run;
    if (
      typeof sha !== "string" ||
      !/^[0-9a-f]{40}$/.test(sha) ||
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      typeof status !== "string" ||
      (conclusion !== null && typeof conclusion !== "string")
    ) {
      fail("a run does not have the expected fields");
    }
    return {
      sha,
      number,
      green: status === "completed" && conclusion === "success",
    };
  });
}

export async function newestGreen(
  api: string,
  repo: string,
  candidates: readonly string[],
): Promise<string> {
  const newest = new Map<string, Run>();
  for (let page = 1; page <= PAGES; page++) {
    const url =
      `${api}/repos/${repo}/actions/workflows/build.yml/runs` +
      `?branch=main&event=push&per_page=${PER_PAGE}&page=${page}`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "isomux-hosted-auto-deploy",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
    } catch (error) {
      fail(`the request failed (${(error as Error).name})`);
    }
    if (response.status !== 200) fail(`the API answered ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      fail("the answer is not JSON");
    }
    const runs = runsOf(body);
    for (const run of runs) {
      const seen = newest.get(run.sha);
      if (!seen || run.number > seen.number) newest.set(run.sha, run);
    }
    if (runs.length < PER_PAGE) break;
  }
  return candidates.find((sha) => newest.get(sha)?.green) ?? "none";
}

if (import.meta.main) {
  const [api, repo, ...candidates] = process.argv.slice(2);
  if (
    !api ||
    !/^https?:\/\/[^\s/]+(:\d+)?$/.test(api) ||
    !repo ||
    !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
    candidates.length === 0 ||
    !candidates.every((sha) => /^[0-9a-f]{40}$/.test(sha))
  ) {
    fail("usage: build-runs.ts <api base> <owner/repo> <sha>...");
  }
  console.log(await newestGreen(api, repo, candidates));
}
