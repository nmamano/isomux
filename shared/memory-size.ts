// The size a memory scope contributes to an agent prompt: non-empty lines,
// newline-joined. Shared by server cap enforcement and the settings editors.
export function injectedMemorySize(text: string): number {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .join("\n").length;
}
