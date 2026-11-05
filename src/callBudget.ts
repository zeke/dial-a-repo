import { DurableObject } from "cloudflare:workers";

/** Hard cap on a single call, regardless of remaining budget. */
export const MAX_CALL_SECONDS = 10 * 60;

/** Daily talk time per caller, across all of that caller's calls. */
export const CALLER_DAILY_SECONDS = 20 * 60;

/**
 * Daily talk time across every caller combined. A backstop for spoofed or
 * rotating caller IDs, which can sidestep the per-caller budget.
 */
export const GLOBAL_DAILY_SECONDS = 120 * 60;

/** Below this much remaining time, a call is turned away instead of started. */
export const MIN_CALL_SECONDS = 30;

/** Ledger name shared by all callers, for GLOBAL_DAILY_SECONDS. */
export const GLOBAL_LEDGER = "global";

/** Ledger name shared by every caller with no usable caller ID. */
export const ANONYMOUS_CALLER = "anonymous";

/**
 * Reduces a SIP From header to a stable per-caller ledger name: the E.164
 * number if there is one, otherwise a single shared "anonymous" bucket.
 * Withheld caller IDs show up as missing headers, "anonymous", or an
 * all-zero number like +10000000000, and all of them share one budget so
 * hiding your number doesn't get you a fresh one.
 */
export function callerKey(fromHeader: string | undefined): string {
  const match = fromHeader?.match(/\+?\d{7,15}/);
  if (!match) return ANONYMOUS_CALLER;
  const digits = match[0].replace(/^\+/, "");
  if (/^1?0+$/.test(digits)) return ANONYMOUS_CALLER;
  return `+${digits}`;
}

/**
 * How long a new call may run, in seconds: the per-call cap, limited by
 * whatever's left of the caller's and the global daily budgets.
 */
export function allowedCallSeconds(callerRemaining: number, globalRemaining: number): number {
  return Math.max(0, Math.min(MAX_CALL_SECONDS, callerRemaining, globalRemaining));
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

interface Usage {
  day: string;
  seconds: number;
}

/**
 * Daily talk-time ledger. One instance per caller (keyed by callerKey())
 * plus one shared GLOBAL_LEDGER instance. Usage resets at 00:00 UTC.
 *
 * Usage is recorded when a call ends, so two simultaneous calls from the
 * same caller can each start against the same remaining balance. That's
 * an accepted gap: each call is still bounded by MAX_CALL_SECONDS, and the
 * global ledger bounds the total.
 */
export class CallBudget extends DurableObject<Env> {
  private async usage(now: Date): Promise<Usage> {
    const stored = await this.ctx.storage.get<Usage>("usage");
    const day = utcDay(now);
    return stored?.day === day ? stored : { day, seconds: 0 };
  }

  async remaining(limitSeconds: number, now = new Date()): Promise<number> {
    const { seconds } = await this.usage(now);
    return Math.max(0, limitSeconds - seconds);
  }

  async record(seconds: number, now = new Date()): Promise<void> {
    const usage = await this.usage(now);
    await this.ctx.storage.put<Usage>("usage", { day: usage.day, seconds: usage.seconds + Math.max(0, seconds) });
  }
}
