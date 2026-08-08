# Agent notes: Dial-a-Repo

Working notes for whoever (human or agent) picks this project back up.
See `README.md` for architecture/usage. This file is for **status,
findings, and open threads**.

IMPORTANT: revise this file whenever meaningful changes are made to the
project (new architecture, new gotchas, new providers, deployment status).

## Origin

This project was extracted from
[`zeke/ziki-voice-agent`](https://github.com/zeke/ziki-voice-agent), a
private personal voice-agent project, to be a focused, open-source demo
of building voice agents on Cloudflare. Everything not directly relevant
to "call a number, talk about a public GitHub repo" was deliberately left
behind -- see the README's "Extra credit" section for the list, and
`ziki-voice-agent`'s own `AGENTS.md` for how those features actually work
if this project ever needs to grow into them.

## Status (as of 2026-08-07)

**Code complete, not yet deployed/cut over.** Typecheck, lint, and all
tests pass locally. The phone number **+1 (607) 365-4321** is reused from
`ziki-voice-agent` (see "Reusing the existing phone number" below) but as
of this writing xAI's `byo_trunk` registration for that number still
points its webhook at `ziki-voice-agent`'s Worker, not this one. Cutting
over requires:

1. `npx wrangler deploy` this project.
2. Re-registering the number's webhook with xAI to point at this Worker's
   `/xai/incoming` URL (rotates `XAI_WEBHOOK_SECRET` -- see below).
3. Setting the new `XAI_WEBHOOK_SECRET` and `XAI_API_KEY` as Worker
   secrets here.

Do this deliberately, not by accident -- it takes the number away from
`ziki-voice-agent` (that project will need a new number afterward; not
yet acquired, see its own `AGENTS.md`).

## Current architecture

```
caller dials +1 (607) 365-4321 (SignalWire number)
  -> SignalWire SIP Gateway resource forwards the call via SIP to
     sip:+16073654321@sip.voice.x.ai;transport=tls
  -> xAI (registered as origin: byo_trunk) sends a signed
     realtime.call.incoming webhook to this Worker's /xai/incoming route
  -> Worker verifies the Standard Webhooks signature and hands the call
     off to a CallSession Durable Object keyed by call_id
  -> The Durable Object opens wss://api.x.ai/v1/realtime?call_id=..., sends
     session.update (voice, instructions, the load_repo tool) + a
     force_message greeting, and stays alive relaying events for the
     life of the call
```

Note: SignalWire itself never talks to this Worker. It only forwards SIP
audio to xAI. The Worker only ever hears from xAI, via the webhook. That
means switching which project "owns" the phone number is purely an xAI
registration change (see "Reusing the existing phone number" below) --
SignalWire's SIP Gateway resource doesn't need to change at all.

## Code walkthrough

`src/index.ts` -- the webhook handler:

1. `GET /` serves a small plain-text landing page (phone number + link to
   this repo) -- a nice-to-have for anyone who opens the Worker's URL
   directly.
2. `POST /xai/incoming` reads the raw body, verifies the Standard
   Webhooks signature (`src/webhook.ts`) against `XAI_WEBHOOK_SECRET`,
   parses the event, and ignores anything that isn't
   `realtime.call.incoming` (but still returns 200 so xAI doesn't retry
   forever).
3. Hands the call to a `CallSession` Durable Object keyed by `call_id`
   (not caller identity -- this project doesn't persist anything across
   calls) and returns 200 immediately.

`src/callSession.ts` -- `CallSession.run`, per call:

1. Opens an outbound WebSocket to xAI's realtime API with the API key as
   a bearer token. Note: `fetch()` with a `wss://` URL throws in
   Workers -- use `https://` with an `Upgrade: websocket` header instead
   (see "Two real Worker bugs" below).
2. Sends `session.update`: voice, `BASE_INSTRUCTIONS` (the repo-explainer
   persona), `turn_detection: server_vad`, the `load_repo` tool
   definition, and caller-side transcription (`grok-transcribe`, mostly
   useful for reading conversations back in `wrangler tail`).
3. Sends the greeting as a `force_message` (see "Greeting reliability"
   below) -- not via instructions.
4. Listens for events: transcripts, tool calls (routes
   `response.function_call_arguments.done` to `handleFunctionCall`),
   errors, and the close event that ends the call.

`src/repoTool.ts` -- the `load_repo` tool's implementation (see README's
"The load_repo tool" section for the why). `parseRepoSpec` is the
"owner/repo" / URL parser; `loadRepoContext` does the two parallel
fetches (GitHub REST API + gitingest.com) and truncates the combined
digest to `MAX_DIGEST_CHARS`.

## Why not a shell/exec tool

`ziki-voice-agent` has a general-purpose `exec` tool backed by
[`@cloudflare/computer`](https://github.com/cloudflare/computer), giving
the model a persistent workspace with shell + git access. That's
deliberately not here: a public phone number reaching arbitrary shell
execution is a much bigger safety surface than this demo needs.
`load_repo` only ever makes GET requests to GitHub's API and gitingest's
API -- no cloning, no execution, nothing mutable.

## Reusing the existing phone number

+1 (607) 365-4321 was originally set up for `ziki-voice-agent` (see that
project's `AGENTS.md` for the full SignalWire/xAI provisioning history --
SIP Gateway resource setup, why SignalWire was chosen over other
providers, etc.). Reusing it here means:

- The SignalWire SIP Gateway resource (`cloudflare.signalwire.com`,
  resource `09f4ed07-2a00-4cd9-84fd-ad6340043177`) doesn't change --
  it just forwards to xAI's fixed SIP endpoint regardless of which
  Worker eventually receives xAI's webhook.
- The only real config to move is xAI's `byo_trunk` phone-number
  registration's `webhook.url`. Re-registering it
  (`PATCH`/`POST /v2/phone-numbers`, per xAI's docs) rotates
  `dispatchSigningSecret` -- update this Worker's `XAI_WEBHOOK_SECRET`
  secret to match, every time.
- `ziki-voice-agent` will need its own new number afterward if that
  project's family-hotline use case is still wanted live. Not yet
  sourced -- see that project's own `AGENTS.md`.

## Two real Worker bugs (carried over from ziki-voice-agent, still apply)

1. **`fetch("wss://...")` throws.** Cloudflare Workers' outbound
   WebSocket upgrade requires an `https://` URL with an `Upgrade:
   websocket` header -- it does not accept a `wss://` scheme directly.
2. **The WebSocket from an outbound `fetch()` upgrade is already open.**
   There is no subsequent `"open"` event to wait for -- send initial
   messages immediately after `ws.accept()`, not inside an open handler.

## Greeting reliability: prompting isn't enough, use force_message

Prompting the model to "say exactly this and nothing else" is not
reliable -- in practice it tends to tack on extra filler regardless of
how firmly the instruction is worded. Use xAI's `force_message`
extension instead: a hard-coded, TTS-synthesized `conversation.item.create`
that plays verbatim without the model deciding what to say. Per xAI's
docs, the `force_message` *is* the turn -- do **not** also send
`response.create` for it, or you'll get a second, model-generated turn
stacked on top of the scripted one.

## Development commands

```bash
npm install
npx wrangler types      # generates worker-configuration.d.ts -- required
                        # before typecheck/lint/test on a fresh checkout,
                        # it's gitignored
npx wrangler dev        # local dev server
npx wrangler deploy     # deploy
npx wrangler tail       # live logs
npm run typecheck       # tsc --noEmit
npm run lint            # eslint . (flat config, type-aware, src/ + test/)
npm test                # vitest run, inside the real Workers runtime
```

CI (`.github/workflows/ci.yml`) runs `wrangler types`, typecheck, lint,
and test on every push to `main` and every PR. Test-only
`XAI_API_KEY`/`XAI_WEBHOOK_SECRET` values are injected via
`vitest.config.ts`'s `miniflare.bindings` -- tests never depend on real
secrets or hit the real xAI/GitHub/gitingest APIs (tests that exercise
`load_repo` stub `fetch` first).

## Reminders

- Keep `.env` out of git (already gitignored). Contains `XAI_API_KEY`
  (authenticates the outbound realtime WebSocket) and
  `XAI_WEBHOOK_SECRET` (verifies incoming `realtime.call.incoming`
  webhooks are genuinely from xAI) -- **the secret rotates** every time
  the `byo_trunk` phone number's webhook is re-registered.
- Run `npx wrangler types` after any `wrangler.jsonc` change before
  `npm run typecheck`, or the `Env` type won't reflect it.
- `worker-configuration.d.ts` (generated by `wrangler types`) is
  gitignored and doesn't exist on a fresh checkout -- run
  `npx wrangler types` once before the first typecheck/lint/test.
- `wrangler types` infers the secret properties on `Env` from the
  presence of a local `.env` file -- run it with no `.env` present and
  the generated `Env` interface silently omits them, breaking typecheck
  anywhere they're referenced (CI writes a placeholder `.env` first
  specifically for this reason).

## Next steps / ideas

- Actually cut over the phone number (see "Status" above).
- Consider a short-timeout/size-limit audit on the `load_repo` fetches --
  right now a slow or hanging `gitingest.com` response just makes the
  tool call slow; there's no explicit timeout.
- If `gitingest.com`'s API ever becomes unreliable or disappears, that's
  the thing to replace in `src/repoTool.ts` -- consider GitHub's tree API
  (`git/trees?recursive=1`) plus selective file fetches as a fallback
  that only depends on GitHub itself.
- Consider a rate limit or abuse guard now that this is meant to be
  publicly callable (no `key=`-gated debug/admin routes exist here at
  all, intentionally -- there's nothing to gate).
