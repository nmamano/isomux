// The variables that tie a git command to one repository, as listed by
// `git rev-parse --local-env-vars` (git 2.43). git exports GIT_DIR to its
// hooks: from a linked worktree it is the absolute path
// <main>/.git/worktrees/<name>, so a test that runs `git init` or
// `git config` in a temp dir with it inherited writes into the shared repo
// config, tags and branches instead. git-env.test.ts checks this list against
// the installed git.
export const GIT_REPO_ENV_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
] as const;

/** The GIT_REPO_ENV_VARS that env sets. */
export function inheritedGitRepoEnv(
  env: Record<string, string | undefined>,
): string[] {
  return GIT_REPO_ENV_VARS.filter((name) => env[name] !== undefined);
}
