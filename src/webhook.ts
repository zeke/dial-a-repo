/**
 * Standard Webhooks (https://www.standardwebhooks.com) signature
 * verification, as used by xAI's realtime.call.incoming webhook.
 */

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export interface WebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export function readWebhookHeaders(request: Request): WebhookHeaders {
  return {
    id: request.headers.get("webhook-id"),
    timestamp: request.headers.get("webhook-timestamp"),
    signature: request.headers.get("webhook-signature"),
  };
}

/**
 * Verifies a Standard Webhooks signature. `secret` is the raw signing
 * secret returned once by xAI when the phone number/webhook was created
 * (looks like "whsec_XXXXXXXX...").
 */
export async function verifyWebhookSignature(
  body: string,
  headers: WebhookHeaders,
  secret: string
): Promise<boolean> {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;

  // Reject stale requests (> 5 minutes old) to mitigate replay attacks.
  const timestampSeconds = Number(headers.timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
  if (ageSeconds > 5 * 60) return false;

  const secretBytes = base64ToBytes(secret.replace(/^whsec_/, ""));
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signedContent = `${headers.id}.${headers.timestamp}.${body}`;
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signedContent)
  );
  const expected = bytesToBase64(new Uint8Array(digest));

  // header value looks like "v1,<base64sig> v1,<base64sig2> ..."
  const candidates = headers.signature
    .split(" ")
    .map((part) => part.split(",")[1])
    .filter(Boolean);

  const expectedBytes = new TextEncoder().encode(expected);
  return candidates.some((candidate) =>
    timingSafeEqual(new TextEncoder().encode(candidate), expectedBytes)
  );
}
