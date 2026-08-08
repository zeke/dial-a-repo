import { describe, expect, it } from "vitest";
import { readWebhookHeaders, verifyWebhookSignature } from "../src/webhook";

const SECRET = "whsec_dGVzdC1zZWNyZXQ=";

async function sign(id: string, timestamp: string, body: string): Promise<string> {
  const secretBytes = Uint8Array.from(atob(SECRET.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  const bytes = new Uint8Array(digest);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `v1,${btoa(bin)}`;
}

describe("readWebhookHeaders", () => {
  it("reads the three Standard Webhooks headers", () => {
    const request = new Request("https://example.com", {
      headers: { "webhook-id": "msg_1", "webhook-timestamp": "123", "webhook-signature": "v1,sig" },
    });
    expect(readWebhookHeaders(request)).toEqual({ id: "msg_1", timestamp: "123", signature: "v1,sig" });
  });

  it("returns nulls for missing headers", () => {
    const request = new Request("https://example.com");
    expect(readWebhookHeaders(request)).toEqual({ id: null, timestamp: null, signature: null });
  });
});

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed, fresh request", async () => {
    const id = "msg_1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: "realtime.call.incoming" });
    const signature = await sign(id, timestamp, body);

    const valid = await verifyWebhookSignature(body, { id, timestamp, signature }, SECRET);
    expect(valid).toBe(true);
  });

  it("rejects a request with missing headers", async () => {
    const valid = await verifyWebhookSignature("{}", { id: null, timestamp: "123", signature: "v1,sig" }, SECRET);
    expect(valid).toBe(false);
  });

  it("rejects a tampered body", async () => {
    const id = "msg_1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await sign(id, timestamp, JSON.stringify({ type: "original" }));

    const valid = await verifyWebhookSignature(JSON.stringify({ type: "tampered" }), { id, timestamp, signature }, SECRET);
    expect(valid).toBe(false);
  });

  it("rejects a stale (>5 min old) request", async () => {
    const id = "msg_1";
    const timestamp = String(Math.floor(Date.now() / 1000) - 10 * 60);
    const body = "{}";
    const signature = await sign(id, timestamp, body);

    const valid = await verifyWebhookSignature(body, { id, timestamp, signature }, SECRET);
    expect(valid).toBe(false);
  });

  it("rejects an invalid signature", async () => {
    const id = "msg_1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const valid = await verifyWebhookSignature("{}", { id, timestamp, signature: "v1,aW52YWxpZA==" }, SECRET);
    expect(valid).toBe(false);
  });
});
