// A one-shot prompt (topic, conversation summary) that the engine refused
// for a usage limit. Each backend throws it from oneShotPrompt, so a caller
// tests the class and parses no engine text.
export class OneShotUsageLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OneShotUsageLimitError";
  }
}
