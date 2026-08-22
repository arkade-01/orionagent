/**
 * viem throws richly — a single failed read can carry 50+ lines of request body,
 * ABI dump, and docs links. That is useful in a stack trace and hostile in a
 * report, where the reader wants to know which source failed and why in one
 * line. Keep the detail on the Error object; put a sentence in the report.
 */
export function summarizeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  // viem's BaseError carries a one-line `shortMessage` plus `details`.
  const viem = err as Error & { shortMessage?: string; details?: string };
  const short = viem.shortMessage?.trim();
  const details = viem.details?.trim();
  if (short) return details && details !== short ? `${short} (${details})` : short;

  const firstLine = err.message.split("\n")[0]?.trim() ?? err.message;
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}
