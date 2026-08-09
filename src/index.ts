import { readWebhookHeaders, verifyWebhookSignature } from "./webhook";

export { CallSession } from "./callSession";
export { RepoWorkspace } from "./repoWorkspace";

interface SipHeader {
  name: string;
  value: string;
}

interface IncomingCallEvent {
  type: string;
  data: {
    call_id: string;
    sip_headers?: SipHeader[];
    metadata?: Record<string, unknown>;
  };
}

const LANDING_PAGE = `Dial-a-Repo

Pick up your phone and talk to any public GitHub repository.

Call it: +1 (607) 365-4321 (US number)

Tell it about a public GitHub repo and have a conversation about what it
is and how it works.

Source: https://github.com/zeke/dial-a-repo
`;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(LANDING_PAGE, { headers: { "Content-Type": "text/plain" } });
    }

    if (url.pathname !== "/xai/incoming" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    const body = await request.text();
    const headers = readWebhookHeaders(request);
    const valid = await verifyWebhookSignature(body, headers, env.XAI_WEBHOOK_SECRET);
    if (!valid) {
      console.error("Rejected webhook: invalid or missing signature");
      return new Response("Invalid signature", { status: 401 });
    }

    let event: IncomingCallEvent;
    try {
      event = JSON.parse(body) as IncomingCallEvent;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (event.type !== "realtime.call.incoming") {
      // Ack anything we don't recognize so xAI doesn't retry it forever.
      return new Response("ok", { status: 200 });
    }

    const callId = event.data.call_id;
    const fromHeader = event.data.sip_headers?.find((h) => h.name.toLowerCase() === "from");

    console.log(JSON.stringify({ msg: "incoming_call", call_id: callId, from: fromHeader?.value }));

    // Hand the call off to a Durable Object, which stays alive for the
    // duration of the call independent of this request's waitUntil
    // budget. Keyed by call_id -- this demo doesn't persist anything
    // across calls (see the README's "Extra credit" section for that and
    // other features intentionally left out), so there's no reason to
    // key by caller identity here.
    const stub = env.CALL_SESSION.get(env.CALL_SESSION.idFromName(callId));
    ctx.waitUntil(stub.run(callId));

    return new Response("ok", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
