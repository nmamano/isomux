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

test("release workflow gates its sole publisher on committed build and runtime checks", () => {
  const workflow = Bun.YAML.parse(
    readFileSync(
      new URL("../../.github/workflows/container-release.yml", import.meta.url),
      "utf8",
    ),
  ) as {
    on: { release: { types: string[] } };
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: {
      publish: {
        permissions: Record<string, string>;
        steps: {
          uses?: string;
          run?: string;
          with?: Record<string, unknown>;
        }[];
      };
    };
  };
  expect(workflow.on).toEqual({ release: { types: ["published"] } });
  expect(workflow.concurrency).toEqual({
    group: "container-release-${{ github.event.release.tag_name }}",
    "cancel-in-progress": false,
  });
  const job = workflow.jobs.publish;
  expect(job.permissions).toEqual({ contents: "read", packages: "write" });
  expect(job.steps[0].with).toEqual({
    ref: "${{ github.sha }}",
    "persist-credentials": false,
  });
  const commands = job.steps.flatMap((step) => (step.run ? [step.run] : []));
  expect(commands).toHaveLength(4);
  expect(commands[1]).toContain(
    'deploy/container/build.sh "$REVISION" "$LOCAL_IMAGE"',
  );
  expect(commands[2].trim().split("\n")).toEqual([
    'python3 deploy/container/smoke.py "$LOCAL_IMAGE"',
    'python3 deploy/container/compose-check.py "$LOCAL_IMAGE"',
  ]);
  expect(commands[3].trim()).toBe("python3 scripts/container/publish.py");
});
