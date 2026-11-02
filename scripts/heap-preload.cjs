// The CI heap report (scripts/heap-report.ts). scripts/ci.ts loads this file
// into the tsc and ESLint Node processes with NODE_OPTIONS=--require, and Node
// runs it in every worker thread too. Each heap appends a start line when it
// loads and an end line at exit. V8 runs no exit handler when it aborts on its
// heap limit, so a start with no end is a heap that died.
const report = process.env.ISOMUX_HEAP_REPORT;
if (report) {
  const { appendFileSync } = require("node:fs");
  const v8 = require("node:v8");
  const vm = require("node:vm");
  const { threadId } = require("node:worker_threads");
  // A report that fails gives no line, never a changed exit code: the
  // summary reads a missing end line as no report.
  const write = (line) => {
    try {
      appendFileSync(
        report,
        `${JSON.stringify({ ...line, pid: process.pid, threadId })}\n`,
      );
      return true;
    } catch {
      return false;
    }
  };
  if (write({ start: true })) {
    const profiler = new v8.GCProfiler();
    profiler.start();
    process.on("exit", () => {
      try {
        // The heap after each full GC, and after one more at exit: the end
        // of a run often holds more than the last full GC saw.
        let peak = 0;
        for (const gc of profiler.stop()?.statistics ?? [])
          if (gc.gcType === "MarkSweepCompact")
            peak = Math.max(peak, gc.afterGC.heapStatistics.usedHeapSize);
        v8.setFlagsFromString("--expose-gc");
        vm.runInNewContext("gc")();
        const heap = v8.getHeapStatistics();
        peak = Math.max(peak, heap.used_heap_size);
        write({ end: true, peak, limit: heap.heap_size_limit });
      } catch {
        // No end line: the summary reads it as no report.
      }
    });
  }
}
