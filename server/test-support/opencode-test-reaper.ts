type Supervisor = { shutdown(): Promise<void> };

export function createOpenCodeTestReaper() {
  const supervisors = new Set<Supervisor>();
  const teardowns = new Set<() => Promise<void>>();
  return {
    track(supervisor: Supervisor): void {
      supervisors.add(supervisor);
    },
    add(teardown: () => Promise<void>): () => Promise<void> {
      const run = async () => {
        teardowns.delete(run);
        // A late finally must also stop a server restarted after the hook.
        await teardown();
      };
      teardowns.add(run);
      return run;
    },
    async afterEach(this: void): Promise<void> {
      const pending = [...teardowns];
      teardowns.clear();
      await Promise.all(pending.map((run) => run()));
    },
    async afterAll(this: void): Promise<void> {
      // Bun does not cancel timed-out bodies; they can restart a server after afterEach.
      await Promise.all([...supervisors].map((supervisor) => supervisor.shutdown()));
      supervisors.clear();
    },
  };
}
