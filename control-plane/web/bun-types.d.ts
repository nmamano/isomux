// The services module opens the control-plane store, which speaks bun:sqlite.
// tsc does not pick up @types/bun from this nested package on its own, so the
// reference is explicit rather than left to auto-inclusion.
/// <reference types="bun" />
