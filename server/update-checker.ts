import { execSync } from "child_process";
import { join } from "path";

export interface CommitInfo {
  sha: string;
  message: string;
  date: string; // ISO 8601
}

export interface UpdateStatus {
  updateAvailable: boolean;
  current: CommitInfo;
  latest: CommitInfo;
}

const REPO = "nmamano/isomux";
const CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour
const PROJECT_ROOT = join(import.meta.dir, "..");

const EMPTY_COMMIT: CommitInfo = { sha: "", message: "", date: "" };

let status: UpdateStatus = {
  updateAvailable: false,
  current: { ...EMPTY_COMMIT },
  latest: { ...EMPTY_COMMIT },
};

let onChange: ((s: UpdateStatus) => void) | null = null;

function getLocalCommit(): CommitInfo | null {
  try {
    // Format: hash\nmessage\nISO date
    const out = execSync('git log -1 --format="%H%n%s%n%aI"', { cwd: PROJECT_ROOT, timeout: 5000 })
      .toString()
      .trim();
    const [sha, message, date] = out.split("\n");
    return { sha, message, date };
  } catch {
    return null;
  }
}

async function fetchLatestCommit(): Promise<CommitInfo | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
      headers: { Accept: "application/vnd.github.v3+json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      sha: data.sha,
      message: data.commit?.message?.split("\n")[0] ?? "",
      date: data.commit?.committer?.date ?? "",
    };
  } catch {
    return null;
  }
}

async function check() {
  const current = getLocalCommit();
  if (!current) return;

  const latest = await fetchLatestCommit();
  if (!latest) return;

  const prev = status.updateAvailable;
  status = {
    updateAvailable: current.sha !== latest.sha,
    current,
    latest,
  };

  // Notify only when status changes
  if (status.updateAvailable !== prev && onChange) {
    onChange(status);
  }
}

export function getUpdateStatus(): UpdateStatus {
  return status;
}

export function onUpdateChange(cb: (s: UpdateStatus) => void) {
  onChange = cb;
}

export function startUpdateChecker() {
  // Initial check after a short delay to not slow down startup
  setTimeout(() => check(), 5000);
  setInterval(() => check(), CHECK_INTERVAL);
}
