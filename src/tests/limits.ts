// Every bound on what an untrusted report or trace may cost.
export const LIMITS = {
  traceFileBytes: 1024 * 1024 * 1024,
  centralDirectoryBytes: 16 * 1024 * 1024,
  entries: 10_000,
  entryBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  linesPerEntry: 1_000_000,
  callsPerAttempt: 250_000,
  snapshotNodes: 500_000,
  stepsPerAttempt: 10_000,
  reportBytes: 64 * 1024 * 1024,
  cases: 10_000,
  attemptsPerCase: 16,
  reportDepth: 64,
  textChars: 4096,
} as const;

const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-_])/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

// Nothing a report or trace says may drive a terminal or a PR comment.
export function cleanText(value: string): string {
  return value.replace(ANSI, '').replace(CONTROL, '').slice(0, LIMITS.textChars);
}
