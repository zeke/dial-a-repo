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
  questions a flat digest can't. See "Tools" below.
- [GitHub's REST API](https://docs.github.com/en/rest) and
  [gitingest](https://github.com/coderamp-labs/gitingest): how the
  `load_repo` tool gets real data about a repo. See "Tools" below.

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
   tools available to it (see "Tools" below), and transcription for the
   caller's side of the conversation.
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
   tools (see "Tools" below). The Durable Object runs it and sends the
   result back so the model can speak about what it found.
9. When either side hangs up, the call's Durable Object is done. It
   doesn't persist conversation history (see "Extra credit" below for
   what that would take). A cloned repo's own Durable Object, on the
   other hand, sticks around and gets reused by the next call about that
   repo.

## Tools

The model has four tools available on every call:

- **`load_repo(repo)`**: fetches metadata (description, language, stars,
  license, topics) from GitHub's REST API and a pre-filtered digest of
  the repo's file tree and contents from gitingest, in parallel. This is
  the first tool called whenever a caller mentions a repo. It actually
  calls out to gitingest.com at request time, the digest isn't optional
  or a fallback, `load_repo` depends on it for real file content.
- **`repo_recent_commits(repo, limit?, sinceDays?)`**: commit history
  from a real git clone, either a fixed count or a time window ("what's
  changed in the last month").
- **`repo_file(repo, path, ref?)`**: one file's full content, at HEAD or
  a specific commit, branch, or tag, not truncated the way `load_repo`'s
  digest might be.
- **`repo_diff(repo, from, to?, path?)`**: a unified diff between two
  refs in a real git clone, e.g. `from="HEAD~1"` for "what changed in the
  last commit."

All four accept a repo as `"owner/repo"`, a full `github.com` URL, or a
bare project name with no owner (e.g. "react," "vite," "cheerio"). Bare
names are resolved to the most popular matching public repo via GitHub's
search API. See `AGENTS.md` for how that resolution works and its known
sharp edges.

`load_repo` is read-only and deliberately simple: no shell access, no
arbitrary code execution reachable from a public phone number. Its tree
and content are each hard-truncated independently (see `MAX_TREE_CHARS`
and `MAX_CONTENT_CHARS` in `src/repoTool.ts`) before being handed back to
the model, so a huge monorepo can't blow up the context or the call's
latency.

The other three tools work against a real git clone rather than a flat
API call, via a `RepoWorkspace` Durable Object (`src/repoWorkspace.ts`)
that clones the repo the first time anyone asks about it and reuses that
clone for every future call, refreshing it periodically. That clone runs
through [`@cloudflare/computer`](https://github.com/cloudflare/computer)'s
git client, `isomorphic-git`, a pure-JS implementation that operates
directly on a Durable Object's own SQLite storage. No container, no
`git` binary, and no shell are required. `@cloudflare/computer` itself
supports several execution backends, including full Linux containers,
but this project doesn't need one: the git work here happens without
any execution backend at all, which is even lighter than the V8-isolate
backends `@cloudflare/computer` offers as its container-free option.

This is a deliberate stress test of a preview package: `@cloudflare/computer`'s
own README says plainly it's "PREVIEW ONLY... NOT suitable for
production use at this time." Using it here anyway, on a publicly
callable phone number, is intentional, issues found get filed upstream
(see [cloudflare/computer#89](https://github.com/cloudflare/computer/issues/89)
for one found and worked around while building this: `git.revParse`
doesn't resolve abbreviated commit oids despite its own docs describing
that as supported).

**Dependency note:** `gitingest.com`'s `/api/{owner}/{repo}` endpoint
isn't an officially documented public API, it's how gitingest's own web
frontend works, reverse-engineered from its (also open source) server
code. It's a well-known, actively maintained tool, and using its hosted
instance is the simplest option for a demo. Self-hosting gitingest (it's
a Python app, distributed as a Docker image) would remove that external
dependency, at the cost of running a whole extra service, deliberately
left out to keep this demo focused. If that endpoint ever disappears or
starts rate-limiting hard, that's the tool to swap out.

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

Or, to run this exact project yourself, here's the rough outline:

1. **Clone and install.**

   ```bash
   git clone https://github.com/zeke/dial-a-repo.git
   cd dial-a-repo
   npm install
   ```

2. **Get an xAI API key** from the [xAI console](https://console.x.ai). This
   is what authenticates the outbound realtime WebSocket and (optionally)
   powers web-search-based repo resolution.

3. **Get a phone number that can forward calls to xAI over SIP.** xAI's own
   provisioned numbers don't currently support webhook-based routing, so
   the number has to come from a third-party SIP provider. This project
   uses [SignalWire](https://signalwire.com)'s SIP Gateway resource,
   pointed at `sip:+1XXXXXXXXXX@sip.voice.x.ai;transport=tls`. Any
   provider that can forward SIP to that endpoint should work.

4. **Register the number with xAI** as a `byo_trunk` origin, with its
   webhook pointed at `https://<your-worker>.workers.dev/xai/incoming`.
   This step returns a `dispatchSigningSecret` -- copy it immediately,
   it's only ever shown once.

5. **Point `wrangler.jsonc` at your own Cloudflare account.** Replace
   `account_id` with yours (`wrangler whoami` will show it).

6. **Set your secrets and deploy.**

   ```bash
   npx wrangler secret put XAI_API_KEY
   npx wrangler secret put XAI_WEBHOOK_SECRET
   npx wrangler deploy
   ```

For local development, put both values in a `.env` file instead (used by
`wrangler dev` and by `npx wrangler types`, which needs to run once before
typecheck/lint/test will pick up the `Env` type). See
[AGENTS.md](./AGENTS.md) for the exact provisioning steps, every gotcha
hit along the way, and how to reuse an existing number if you're moving
it from another project.

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
