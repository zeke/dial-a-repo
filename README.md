# Dial-a-Repo

<p align="center">
  <img src="art/octocat-rotary-phone.png" alt="Octocat talking on a red rotary phone" width="300">
</p>

Pick up your phone and talk to any public GitHub repository.

Call [**+1 (607) 365-4321**](tel:+16073654321) (a US phone number) and tell
it about a public GitHub repo, a name or an `owner/repo`. It'll dig in and
have a real, spoken conversation with you about what it is and how it works,
in whichever language you speak to it in. Not sure what to ask about? Just
stay quiet after the greeting and it'll default to talking about
[`cloudflare/computer`](https://github.com/cloudflare/computer).

This is an open-source demo and reference implementation for building
**voice agents on Cloudflare** that can make and receive real phone calls,
not a chatbot with a phone number bolted on. It's meant to be forked and
adapted, not just used.

## What it does

You call the number, and an AI answers with a real-time voice conversation:
natural back-and-forth, interruptions, turn-taking, no pre-recorded menu
tree. Mention a public GitHub repository, and it calls a tool mid-call to
fetch real, current data about that repo (not a guess from stale training
data), then talks you through what it is, what stack it uses, and how it's
structured.

## Stack

- [xAI Voice Agent API](https://docs.x.ai/developers/model-capabilities/audio/voice-agent)
  (beta): the AI on the call. A realtime, bidirectional WebSocket API:
  send it audio and configuration, it sends back audio, transcripts, and
  events. It handles speech-to-text, text-to-speech, voice-activity
  detection, and tool/function calling, and also runs xAI's SIP telephony
  layer, which bridges the phone call's actual audio directly, so this
  project never touches raw audio bytes, only JSON control events over a
  WebSocket.
- [Cloudflare Workers](https://developers.cloudflare.com/workers/): the
  front door. A single Worker (`src/index.ts`) receives xAI's incoming call
  webhook, verifies its signature, and dispatches to a Durable Object.
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/):
  the part that makes a multi-minute phone call possible on a platform
  built around short-lived requests. One `CallSession` Durable Object
  instance exists per call, and stays alive for as long as the call's
  WebSocket to xAI is open, independent of the webhook request that
  spawned it.
- [SignalWire](https://signalwire.com): the telephony provider. It owns
  the phone number and forwards inbound calls over SIP to xAI. It's used
  because xAI's own provisioned numbers don't currently support
  webhook-based routing, so the number itself has to come from a
  third-party SIP provider instead.
- [`@cloudflare/computer`](https://github.com/cloudflare/computer): a
  persistent, SQLite-backed virtual filesystem for Durable Objects, used
  here for its git client so the model can clone a repo and answer
  questions a flat digest can't.
- [GitHub's REST API](https://docs.github.com/en/rest) and
  [gitingest](https://github.com/coderamp-labs/gitingest): how the
  `load_repo` tool gets real data about a repo.

## How it Works

1. A caller dials the number. SignalWire's SIP Gateway resource forwards
   the call over SIP to xAI's SIP endpoint.
2. xAI sends a signed webhook to the Worker announcing the incoming call.
3. The Worker verifies the webhook's signature, a Standard Webhooks HMAC
   that proves the request genuinely came from xAI, and rejects anything
   invalid, unsigned, or too old.
4. The Worker hands the call off to a dedicated Durable Object for that
   call, and immediately acknowledges the webhook so xAI doesn't retry.
   Everything from here on happens inside the Durable Object, independent
   of that webhook request's lifetime. A Durable Object holds the call
   open because a plain Worker's background-task budget isn't built to
   sustain a multi-minute phone call.
5. The Durable Object opens a WebSocket to xAI's realtime API and
   configures the session: which voice to use, automatic server-side
   voice-activity detection (so the model knows when the caller has
   finished a turn, or is interrupting it mid-sentence), the four repo
   tools available to it, and transcription for the caller's side of the
   conversation.
6. The greeting is sent separately, as a scripted line played back
   verbatim through text-to-speech, not something the model composes on
   the fly. Prompting the model to "say exactly this and nothing else"
   turned out to be unreliable in practice, it kept adding filler, so a
   scripted greeting guarantees the exact wording.
7. From there the conversation runs on its own: xAI's servers handle
   voice-activity detection, transcription, and turn-taking automatically.
   The Durable Object listens for events (transcripts, tool calls, errors)
   as they arrive.
8. When the caller mentions a repo, the model calls one of the four repo
   tools. The Durable Object runs it and sends the result back so the
   model can speak about what it found.
9. When either side hangs up, the call's Durable Object is done. It
   doesn't persist conversation history (see "Extra credit" below for
   what that would take). A cloned repo's own Durable Object, on the
   other hand, sticks around and gets reused by the next call about that
   repo.

## Running your own instance

This is meant to be forked, not just used. Easiest way: hand this repo
to a coding agent as reference and have it build you a different voice
agent.

> Copy this and paste it into your agent:
>
> ```
> Let's build a voice agent that can make and receive real phone calls!
>
> Use this repo for reference: https://github.com/zeke/dial-a-repo
> ```

Want to run this exact project instead? See [AGENTS.md](./AGENTS.md) for
the full setup: getting an xAI API key, wiring up a SIP-forwarding phone
number, registering the webhook, secrets, and deploying, plus every
gotcha hit along the way.

## Extra credit

This project is deliberately narrow: a handful of read-only repo tools,
no conversation memory, no per-caller identity. Here are some ideas on
how you could extend it:

- **Cross-call memory**: key the `CallSession` Durable Object by the
  caller's phone number instead of the call's own id, so the same
  instance, and its SQLite storage, can persist a rolling summary of past
  conversations across calls.
- **Per-caller personas**: a phone-number-to-persona lookup table, so
  known callers get a personalized greeting.
- **Outbound calling**: place a call *from* the agent's number to a
  known number via SignalWire's Compatibility API, then bridge the
  answered call into the same SIP destination inbound calls use, so it
  looks like a normal inbound call to xAI once answered.
- **A general-purpose shell/exec tool**: give the model an actual shell
  (via `@cloudflare/computer`'s worker-shell backend) to run arbitrary
  commands in a persistent workspace, instead of the narrow, read-only
  git operations this project exposes.

None of these are implemented here, they're just not what this demo is
about.

See [AGENTS.md](./AGENTS.md) for the full architecture writeup, exact
commands, provider setup, and every gotcha found along the way.
