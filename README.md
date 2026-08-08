# Dial-a-Repo

Call **+1 (607) 365-4321** (a US phone number) and tell it about a public
GitHub repo -- a name, an `owner/repo`, or a full URL. It'll dig in and have
a real, spoken conversation with you about what it is and how it works. Not
sure what to ask about? Just stay quiet after the greeting and it'll default
to talking about [`cloudflare/computer`](https://github.com/cloudflare/computer).

This is an open-source demo and reference implementation for building
**voice agents on Cloudflare** that can make and receive real phone calls --
not a chatbot with a phone number bolted on. It's meant to be forked and
adapted, not just used.

## What it does

You call the number, and an AI answers with a real-time voice conversation --
natural back-and-forth, interruptions, turn-taking, no pre-recorded menu
tree. Mention a public GitHub repository, and it calls a tool mid-call to
fetch real, current data about that repo (not a guess from stale training
data), then talks you through what it is, what stack it uses, and how it's
structured.

None of this needs Twilio Media Streams, manual audio codec handling, or
WebRTC -- [xAI's SIP infrastructure](https://docs.x.ai/developers/model-capabilities/audio/voice-agent/sip)
bridges the phone call's audio directly, so the Worker's job is limited to
configuring the session and reacting to events, never touching raw audio.

## How it works

```
caller dials +1 (607) 365-4321
  -> SignalWire (SIP trunk) forwards the call via SIP to xAI
  -> xAI sends a signed webhook to this Worker
  -> Worker verifies the webhook and hands the call to a Durable Object
     keyed by the call's own id
  -> the Durable Object opens a WebSocket to xAI's realtime API,
     configures the session (voice, instructions, four repo tools),
     and relays events for the life of the call
  -> when the caller mentions a repo, the model calls load_repo, which
     fetches GitHub's API + a gitingest.com digest in parallel and
     hands real repo content back to the model to talk from
  -> for deeper questions ("what changed last month," "show me this
     file," "diff that commit"), the model calls one of three tools
     backed by a real git clone -- see "Real git, no container" below
```

A [Durable Object](https://developers.cloudflare.com/durable-objects/) holds
the call open because a plain Worker's background-task budget
(`ctx.waitUntil()`) isn't built to sustain a multi-minute phone call.

See [AGENTS.md](./AGENTS.md) for the full architecture writeup, exact
commands, provider setup, and every gotcha found along the way.

## Stack

- [xAI Voice Agent API](https://docs.x.ai/developers/model-capabilities/audio/voice-agent)
  (beta) -- the AI on the call. A realtime, bidirectional WebSocket API:
  send it audio and configuration, it sends back audio, transcripts, and
  events. It handles speech-to-text, text-to-speech, voice-activity
  detection, and tool/function calling, and also runs xAI's SIP telephony
  layer, which is what makes the "no audio code" part possible -- xAI
  bridges the phone call's actual audio directly, so this project never
  touches raw audio bytes, only JSON control events over a WebSocket.
- [Cloudflare Workers](https://developers.cloudflare.com/workers/) -- the
  front door. A single Worker (`src/index.ts`) receives xAI's incoming call
  webhook, verifies its signature, and dispatches to a Durable Object.
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/) --
  the part that makes a multi-minute phone call possible on a platform
  built around short-lived requests. One `CallSession` Durable Object
  instance exists per call, and stays alive for as long as the call's
  WebSocket to xAI is open, independent of the webhook request that
  spawned it.
- [SignalWire](https://signalwire.com) -- the telephony provider. It owns
  the phone number and the SIP trunk that connects it to xAI for inbound
  calls.
- [GitHub's REST API](https://docs.github.com/en/rest) and
  [gitingest](https://github.com/coderamp-labs/gitingest) -- how the
  `load_repo` tool gets real data about a repo. See "The load_repo tool"
  below.
- [`@cloudflare/computer`](https://github.com/cloudflare/computer) -- a
  persistent, SQLite-backed virtual filesystem for Durable Objects, used
  here for its git client (`isomorphic-git`, pure JS, no shell or
  container needed) so the model can clone a repo and answer questions
  a flat digest can't. See "Real git, no container" below.

## Anatomy of a call

1. A caller dials +1 (607) 365-4321. SignalWire's SIP Gateway resource
   forwards the call over SIP to xAI's SIP endpoint.
2. xAI sends a signed `realtime.call.incoming` webhook to the Worker's
   `/xai/incoming` route, carrying a `call_id`.
3. The Worker verifies the webhook's signature -- a Standard Webhooks
   HMAC that proves the request genuinely came from xAI -- and rejects
   anything invalid, unsigned, or older than five minutes.
4. The Worker hands the call off to a `CallSession` Durable Object, keyed
   by `call_id`, and immediately responds "ok" to xAI. Everything from
   here on happens inside the Durable Object, independent of that webhook
   request's lifetime.
5. The Durable Object opens a WebSocket to xAI's realtime API and sends a
   `session.update` event: which voice to use, automatic server-side
   voice-activity detection (so the model knows when the caller has
   finished a turn, or is interrupting it mid-sentence), the `load_repo`
   tool definition, and the speech-to-text model for transcription.
6. The greeting is sent separately, as a `force_message` -- a scripted
   line played back verbatim through text-to-speech, not something the
   model composes on the fly. Prompting the model to "say exactly this
   and nothing else" turned out to be unreliable in practice (it kept
   adding filler); a `force_message` guarantees the exact wording.
7. From there the conversation runs on its own: xAI's servers handle
   voice-activity detection, transcription, and turn-taking automatically.
   The Durable Object listens for events (transcripts, tool calls, errors)
   as they arrive.
8. When the caller mentions a repo, the model calls `load_repo`, or one
   of the three git-backed tools (see "Real git, no container" below).
   The Durable Object runs it, sends the result back as a
   `function_call_output`, and triggers a `response.create` so the model
   speaks about what it found.
9. When either side hangs up, the WebSocket closes and the `CallSession`
   Durable Object is done -- it doesn't persist conversation history
   (see "Extra credit" below for what that would take). A cloned repo's
   *own* Durable Object, on the other hand, sticks around and gets reused
   by the next call about that repo -- see below.

## The `load_repo` tool

One tool, kept deliberately simple and read-only: no shell access, no
cloning, no arbitrary code execution reachable from a public phone
number. When the model calls `load_repo(repo)`, the Durable Object makes
two requests in parallel:

1. **GitHub's REST API** (`GET /repos/{owner}/{repo}`) for metadata --
   description, language, stars, forks, license, topics.
2. **[gitingest](https://github.com/coderamp-labs/gitingest)'s** hosted
   API (`gitingest.com`, 15k+ GitHub stars, actively maintained) for a
   pre-filtered digest of the repo's file tree and contents -- one call
   gets "the whole repo, efficiently," instead of the model browsing
   files one at a time.

The combined result is hard-truncated (see `MAX_DIGEST_CHARS` in
`src/repoTool.ts`) before it's handed back to the model, so a huge
monorepo can't blow up the context or the call's latency -- a phone
conversation needs a summary to talk from, not an entire repo's source.

**Dependency note:** `gitingest.com`'s `/api/{owner}/{repo}` endpoint
isn't an officially documented public API -- it's how gitingest's own web
frontend works, reverse-engineered from its (also open source) server
code. It's a well-known, actively maintained tool, and using its hosted
instance is the simplest option for a demo. Self-hosting gitingest
(it's a Python app, distributed as a Docker image) would remove that
external dependency, at the cost of running a whole extra service --
deliberately left out to keep this demo focused. If that endpoint ever
disappears or starts rate-limiting hard, that's the tool to swap out.

## Real git, no container

`load_repo`'s digest is a flat, truncated snapshot -- great for "what is
this and how does it work," not enough for "what changed last month" or
"show me this whole file." Three more tools answer those by working
against a **real git clone**, not another flat API call:

- **`repo_recent_commits(repo, limit?, sinceDays?)`** -- commit history,
  either a fixed count or a time window ("what's changed in the last
  month").
- **`repo_file(repo, path, ref?)`** -- one file's full content, at HEAD
  or a specific commit/branch/tag, not truncated the way `load_repo`'s
  digest might be.
- **`repo_diff(repo, from, to?, path?)`** -- a unified diff between two
  refs, e.g. `from="HEAD~1"` for "what changed in the last commit."

All three are backed by a `RepoWorkspace` Durable Object
(`src/repoWorkspace.ts`) using
[`@cloudflare/computer`](https://github.com/cloudflare/computer)'s git
client -- which is [`isomorphic-git`](https://github.com/isomorphic-git/isomorphic-git),
a pure-JS git implementation, "operating directly on the local SQLite
VFS -- no backend or shell required" per its docs. That's the key thing
that makes this possible without a container: no `git` binary, no Worker
Loader, no `experimental` compatibility flag, just `nodejs_compat` and a
Durable Object.

`RepoWorkspace` is keyed by repo slug (`owner/repo`), not by call --
once anyone asks about a repo, it's cloned (shallow, capped at ~200 MB)
and cached there for every future call about that repo, refreshed with a
fast-forward pull if the last sync is more than 15 minutes old. Cloning
a repo nobody's asked about yet takes a few seconds; every call after
that is fast.

**This is a deliberate stress test of a preview package.**
`@cloudflare/computer`'s own README says plainly: "PREVIEW ONLY... NOT
suitable for production use at this time." Using it here anyway, on a
publicly callable phone number, is intentional -- issues found get filed
upstream (see [cloudflare/computer#89](https://github.com/cloudflare/computer/issues/89)
for one found and worked around while building this: `git.revParse`
doesn't resolve abbreviated commit oids despite its own docs describing
that as supported).

## Why SignalWire

xAI's own provisioned phone numbers don't currently support webhook-based
routing (see AGENTS.md), so the phone number itself comes from a
third-party SIP provider instead. SignalWire owns the number and forwards
inbound calls over SIP directly to xAI -- this Worker never talks to
SignalWire at all for inbound calls, only xAI's webhook.

## Extra credit

This project is deliberately narrow: a handful of read-only repo tools,
no conversation memory, no per-caller identity. A sibling project,
[ziki-voice-agent](https://github.com/zeke/ziki-voice-agent), is the
private, personal voice-agent project this one was extracted from, and
still has these features working if you want to see how they're built:

- **Cross-call memory** -- keying the `CallSession` Durable Object by the
  caller's phone number (not `call_id`) so the same instance, and its
  SQLite storage, persists a rolling summary of past conversations across
  calls.
- **Per-caller personas** -- a hardcoded phone-number-to-persona lookup
  table, so known callers get a personalized greeting.
- **Outbound calling** -- placing a call *from* the agent's number to a
  known number via SignalWire's Compatibility API, then bridging the
  answered call into the same SIP destination inbound calls use, so it
  looks like a normal inbound call to xAI once answered.
- **A general-purpose shell/exec tool** -- giving the model an actual
  shell (via `@cloudflare/computer`'s worker-shell backend) to run
  arbitrary commands in a persistent workspace, not just the narrow,
  read-only git operations this project exposes.

Any of these would be reasonable things to add here too -- they're just
not what this demo is about.

## Multilingual

The underlying model supports 20+ languages out of the box -- it detects
which language the caller is speaking and responds in kind automatically,
with no per-call configuration needed (see xAI's
[Supported Languages](https://docs.x.ai/developers/model-capabilities/audio/voice-agent)
docs for the full list).
