import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const SECRET = env.XAI_WEBHOOK_SECRET;

async function signedRequest(body: string, opts: { id?: string; timestamp?: string; badSig?: boolean } = {}) {
  const id = opts.id ?? "msg_1";
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));

  let signature: string;
  if (opts.badSig) {
    signature = "v1,aW52YWxpZC1zaWduYXR1cmU=";
  } else {
    const secretBytes = Uint8Array.from(atob(SECRET.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
    const sigBytes = new Uint8Array(digest);
    let bin = "";
    for (const b of sigBytes) bin += String.fromCharCode(b);
    signature = `v1,${btoa(bin)}`;
  }

  return new Request("https://example.com/xai/incoming", {
    method: "POST",
    body,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Worker /", () => {
  it("serves a plain-text landing page", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://example.com/"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Dial-a-Repo");
  });
});

describe("Worker /xai/incoming", () => {
  it("404s on an unknown path", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://example.com/nope"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(404);
  });

  it("404s on GET (only POST is accepted)", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://example.com/xai/incoming"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(404);
  });

  it("rejects a request with no webhook headers", async () => {
    const ctx = createExecutionContext();
    const request = new Request("https://example.com/xai/incoming", { method: "POST", body: "{}" });
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });

  it("rejects a request with an invalid signature", async () => {
    const ctx = createExecutionContext();
    const request = await signedRequest(JSON.stringify({ type: "realtime.call.incoming" }), { badSig: true });
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });

  it("rejects a stale (>5 min old) request even with a valid signature", async () => {
    const ctx = createExecutionContext();
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 10 * 60);
    const request = await signedRequest(JSON.stringify({ type: "realtime.call.incoming" }), {
      timestamp: staleTimestamp,
    });
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });

  it("acks (200) an event type it doesn't handle, without dispatching to a Durable Object", async () => {
    const ctx = createExecutionContext();
    const request = await signedRequest(JSON.stringify({ type: "some.other.event" }));
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
  });

  it("returns 200 immediately for a valid realtime.call.incoming event", async () => {
    // Avoid a real outbound call to api.x.ai from the background dispatch --
    // the Worker's own response doesn't wait on it anyway, but stub it out
    // for a hermetic, non-networked test run.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response("upgrade required", { status: 426 }))
    );

    const ctx = createExecutionContext();
    const body = JSON.stringify({
      type: "realtime.call.incoming",
      data: {
        call_id: "call_123",
        sip_headers: [{ name: "From", value: "+14155550100" }],
      },
    });
    const request = await signedRequest(body);
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    await waitOnExecutionContext(ctx);
  });

  it("returns 400 for invalid JSON", async () => {
    const ctx = createExecutionContext();
    const request = await signedRequest("not json");
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
  });
});
