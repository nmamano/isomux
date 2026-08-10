// The transcripts under e2e/ are Bun scripts - `Bun.spawn`, `import.meta.dir` -
// and tsc does not pick up @types/bun from this nested package on its own, so
// the reference is explicit rather than left to auto-inclusion.
/// <reference types="bun" />
