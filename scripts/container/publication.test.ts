import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

test("publisher protocol refuses errors and collisions and preserves retries", () => {
  const result = spawnSync(
    "python3",
    [
      "-B",
      "-m",
      "unittest",
      "discover",
      "-s",
      "scripts/container",
      "-p",
      "*_test.py",
    ],
    {
      cwd: new URL("../../", import.meta.url),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  expect({ status: result.status, output: result.stderr }).toEqual({
    status: 0,
    output: expect.stringContaining("OK"),
  });
});

test("release workflow gates its sole publisher on both architectures' build and runtime checks", () => {
  const source = readFileSync(
    new URL("../../.github/workflows/container-release.yml", import.meta.url),
    "utf8",
  );
  type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
  type Job = {
    needs?: string;
    if?: string;
    "runs-on": string;
    permissions?: Record<string, string>;
    strategy?: { matrix: { include: { arch: string; runner: string }[] } };
    steps: Step[];
  };
  const workflow = Bun.YAML.parse(source) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: Record<string, Job>;
  };
  expect(workflow.on).toEqual({
    release: { types: ["published"] },
    workflow_dispatch: null,
  });
  expect(workflow.permissions).toEqual({ contents: "read" });
  // One writer per release tag; each probe run is its own group.
  expect(workflow.concurrency).toEqual({
    group:
      "container-release-${{ github.event.release.tag_name || format('probe-{0}', github.run_id) }}",
    "cancel-in-progress": false,
  });
  const commands = (job: Job) =>
    job.steps.flatMap((step) => (step.run ? [step.run.trim()] : []));

  // Native builds, one per architecture, each with every image gate.
  const image = workflow.jobs.image;
  expect(image.strategy!.matrix.include).toEqual([
    { arch: "amd64", runner: "ubuntu-24.04" },
    { arch: "arm64", runner: "ubuntu-24.04-arm" },
  ]);
  expect(image["runs-on"]).toBe("${{ matrix.runner }}");
  expect(image.permissions).toBeUndefined();
  expect(image.steps[0].with).toEqual({
    ref: "${{ github.event_name == 'release' && format('refs/tags/{0}', github.event.release.tag_name) || github.sha }}",
    "persist-credentials": false,
  });
  const gates = commands(image);
  expect(gates).toHaveLength(4);
  expect(gates[0]).toContain('test "$(git rev-parse HEAD)" = "$REVISION"');
  expect(gates[0]).toContain(
    'test "$(git rev-parse "refs/tags/$RELEASE_TAG^{commit}")" = "$REVISION"',
  );
  expect(gates[1]).toBe(
    'bash deploy/container/build.sh "$REVISION" "$LOCAL_IMAGE"',
  );
  expect(gates[2].split("\n")).toEqual([
    'python3 deploy/container/smoke.py "$LOCAL_IMAGE"',
    'python3 deploy/container/compose-check.py "$LOCAL_IMAGE"',
  ]);
  // A release image must report its tag; a probe image reports none.
  expect(gates[3]).toContain(
    'if [[ $GITHUB_EVENT_NAME == release ]]; then identity=(--release "$RELEASE_TAG"); else identity=(--unreleased); fi',
  );
  expect(gates[3]).toContain(
    'scripts/container/publish.py layout ${{ matrix.arch }} "$RUNNER_TEMP/layout" "${identity[@]}"',
  );
  expect(image.steps.at(-1)!.uses).toStartWith("actions/upload-artifact@");

  // The only job that can write packages runs after both builds, on releases.
  const writers = Object.entries(workflow.jobs)
    .filter(([, job]) => job.permissions?.packages)
    .map(([name]) => name);
  expect(writers).toEqual(["publish"]);
  const publish = workflow.jobs.publish;
  expect(publish.needs).toBe("image");
  expect(publish.if).toBe("github.event_name == 'release'");
  expect(publish.permissions).toEqual({
    contents: "read",
    packages: "write",
  });
  expect(publish.steps[0].with).toEqual({
    ref: "refs/tags/${{ github.event.release.tag_name }}",
    "persist-credentials": false,
  });
  expect(commands(publish)).toEqual([
    'python3 scripts/container/publish.py publish "$RUNNER_TEMP/layout-amd64" "$RUNNER_TEMP/layout-arm64"',
  ]);

  // A probe rehearses against a local registry and never reaches a secret.
  const rehearse = workflow.jobs.rehearse;
  expect(rehearse.needs).toBe("image");
  expect(rehearse.if).toBe("github.event_name == 'workflow_dispatch'");
  expect(commands(rehearse)[0]).toStartWith(
    'python3 scripts/container/publish.py rehearse "$REHEARSAL"',
  );
  expect(JSON.stringify(rehearse)).not.toContain("secrets.");
  expect(JSON.stringify(image)).not.toContain("secrets.");
});
