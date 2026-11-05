import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  allowedCallSeconds,
  ANONYMOUS_CALLER,
  CALLER_DAILY_SECONDS,
  callerKey,
  MAX_CALL_SECONDS,
} from "../src/callBudget";

describe("callerKey", () => {
  it("returns the E.164 number from a bare From header", () => {
    expect(callerKey("+14155550100")).toBe("+14155550100");
  });

  it("extracts the number from a SIP URI", () => {
    expect(callerKey("<sip:+972521234567@sip.example.com>;tag=abc")).toBe("+972521234567");
  });

  it("buckets missing, anonymous, and all-zero caller IDs together", () => {
    expect(callerKey(undefined)).toBe(ANONYMOUS_CALLER);
    expect(callerKey("anonymous")).toBe(ANONYMOUS_CALLER);
    expect(callerKey("+10000000000")).toBe(ANONYMOUS_CALLER);
  });
});

describe("allowedCallSeconds", () => {
  it("caps at MAX_CALL_SECONDS when budgets are plentiful", () => {
    expect(allowedCallSeconds(10_000, 10_000)).toBe(MAX_CALL_SECONDS);
  });

  it("is limited by whichever budget has less left", () => {
    expect(allowedCallSeconds(120, 10_000)).toBe(120);
    expect(allowedCallSeconds(10_000, 45)).toBe(45);
  });

  it("never goes negative", () => {
    expect(allowedCallSeconds(-5, 100)).toBe(0);
  });
});

describe("CallBudget", () => {
  it("subtracts recorded usage from the daily limit", async () => {
    const ledger = env.CALL_BUDGET.getByName("test_caller_1");
    const now = new Date("2026-11-05T12:00:00Z");
    expect(await ledger.remaining(CALLER_DAILY_SECONDS, now)).toBe(CALLER_DAILY_SECONDS);
    await ledger.record(300, now);
    await ledger.record(200, now);
    expect(await ledger.remaining(CALLER_DAILY_SECONDS, now)).toBe(CALLER_DAILY_SECONDS - 500);
  });

  it("floors remaining time at zero", async () => {
    const ledger = env.CALL_BUDGET.getByName("test_caller_2");
    const now = new Date("2026-11-05T12:00:00Z");
    await ledger.record(CALLER_DAILY_SECONDS + 100, now);
    expect(await ledger.remaining(CALLER_DAILY_SECONDS, now)).toBe(0);
  });

  it("resets at 00:00 UTC", async () => {
    const ledger = env.CALL_BUDGET.getByName("test_caller_3");
    await ledger.record(CALLER_DAILY_SECONDS, new Date("2026-11-05T23:59:00Z"));
    expect(await ledger.remaining(CALLER_DAILY_SECONDS, new Date("2026-11-05T23:59:30Z"))).toBe(0);
    expect(await ledger.remaining(CALLER_DAILY_SECONDS, new Date("2026-11-06T00:00:10Z"))).toBe(
      CALLER_DAILY_SECONDS
    );
  });
});
