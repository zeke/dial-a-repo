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

## Status (as of 2026-08-08)

**Live**, now with real git tooling. Deployed to
`https://dial-a-repo.ziki.workers.dev`, with a second Durable Object
class (`RepoWorkspace`, `src/repoWorkspace.ts`) giving the model a real
git clone to work from -- see "Real git tooling" below. The phone number
**+1 (607) 365-4321** was cut over from `ziki-voice-agent` to this
project on the same day:

1. Deployed via `npx wrangler deploy`.
2. xAI's `byo_trunk` registration for that number was deleted and
   re-created (there's no in-place PATCH for a phone number's webhook --
   see "Reusing the existing phone number" below) pointing at this
   Worker's `/xai/incoming` URL. That rotated `dispatchSigningSecret`.
3. The new `XAI_WEBHOOK_SECRET` and `XAI_API_KEY` were set as Worker
   secrets here via `wrangler secret put`.

`ziki-voice-agent` no longer has a working phone number as a result --
it needs a new one before it can receive calls again (see its own
`AGENTS.md`).

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
     session.update (voice, instructions, four repo tools) + a
     force_message greeting, and stays alive relaying events for the
     life of the call
  -> the git-backed tools (repo_recent_commits, repo_file, repo_diff)
     each reach into a *separate* RepoWorkspace Durable Object, keyed by
     repo slug (not call_id), which owns a real cloned git repo and is
     reused by every future call about that same repo
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
"The load_repo tool" section for the why), plus `resolveCloneTarget`,
used by the three git-backed tools to turn caller input into a clone
URL + default branch + size (for the size guard in `ensureCloned`).
`parseRepoSpec` is the shared "owner/repo" / URL parser. `loadRepoContext`
does the two parallel fetches (GitHub REST API + gitingest.com) and
truncates the combined digest to `MAX_TREE_CHARS` + `MAX_CONTENT_CHARS`
(separately -- see "A real bug found on a live call" below for why not
one combined cap).

`src/repoWorkspace.ts` -- the `RepoWorkspace` Durable Object. See "Real
git tooling" below.

## Why not a general-purpose shell/exec tool

`ziki-voice-agent` has a general-purpose `exec` tool backed by
[`@cloudflare/computer`](https://github.com/cloudflare/computer)'s
worker-shell backend, giving the model a persistent workspace with an
actual shell. That's deliberately not here: a public phone number
reaching arbitrary shell execution is a much bigger safety surface than
this demo needs. This project *does* use `@cloudflare/computer`, just its
git client only (see below) -- clone, log, diff, show, no shell, no
command execution of any kind.

## Real git tooling (added 2026-08-08)

`load_repo`'s gitingest digest is a flat, truncated snapshot -- fine for
"what is this," not enough for "what changed last month" or "show me
this whole file." Three more tools (`repo_recent_commits`, `repo_file`,
`repo_diff` in `src/callSession.ts`'s `TOOLS`) answer those against a
**real git clone**, via a new `RepoWorkspace` Durable Object.

**No container needed.** This took investigation to get right --
`@cloudflare/computer`'s git client is
[`isomorphic-git`](https://github.com/isomorphic-git/isomorphic-git) (pure
JS), "operating directly on the local SQLite VFS -- no backend or shell
required" per `docs/13_git_interface.md` in that repo. That means `git
clone`/`log`/`diff`/`show` work in a plain Durable Object with just the
`nodejs_compat` compatibility flag -- no `worker_loaders`, no
`experimental` flag, no Worker Loader, no container, none of the
worker-shell backend's machinery. `RepoWorkspace` only sets `git:
createGitClient()` in its `withWorkspace` options -- no `backends` array
at all.

**Real dependency, not just a peer dep footnote.** `@cloudflare/computer`'s
README calls `@platformatic/vfs` an "optional peer dependency," which
reads like it might not be needed -- it is. `git.js`'s
`workspaceIsomorphicGitClient` does `await import("@platformatic/vfs")`
unconditionally the first time any git operation runs; skip installing
it and every git call throws. Both are real `dependencies` here, not
devDependencies.

**Caching, not per-call cloning.** `RepoWorkspace` is keyed by repo slug
(`owner/repo`), not `call_id` -- `ensureCloned()` clones once (shallow,
`depth: 200`, guarded by `MAX_REPO_SIZE_KB` so nobody can make it clone
"torvalds/linux" live on a call) and reuses that same clone for every
future call about that repo, refreshing with a fast-forward `pull` if
the last sync is older than `REFRESH_AFTER_MS` (15 min). First call
about a new repo pays the clone cost; every call after that is fast.

**This is a deliberate stress test of a preview package**, not an
oversight -- see the README's "Real git, no container" section for why
that's an acceptable tradeoff here.

### A real upstream bug found while building this

`git.revParse` doesn't resolve abbreviated (short) commit oids, despite
`docs/13_git_interface.md` explicitly describing "short oid prefix" as
supported. Repro'd live against `octocat/Hello-World`: a 7-char prefix of
a real commit oid (taken directly from that same commit's own `git.log`
output) throws `GitError: git rev-parse failed: Could not find
<prefix>.`, while the full 40-char oid resolves fine. Filed as
[cloudflare/computer#89](https://github.com/cloudflare/computer/issues/89).

Worked around on our end in `RepoWorkspace.recentCommits`: it returns
full 40-char oids, not the usual 7-char short form, specifically so an
oid the model reuses as `ref`/`from` on `repo_file`/`repo_diff` stays
resolvable. If that upstream bug gets fixed, the full-oid workaround can
stay (it's not wrong, just more verbose) or be reverted to short oids for
nicer tool output -- either is fine.

### How `RepoWorkspace` was actually verified

This project's usual testing convention is "stub `fetch`, no real
network in tests" (see `repoTool.test.ts`). `test/repoWorkspace.test.ts`
is a deliberate exception: it clones a real, tiny, effectively frozen
public repo (`octocat/Hello-World`, GitHub's own long-standing test
fixture) over real network, because mocking isomorphic-git's smart HTTP
protocol negotiation and pack parsing convincingly enough to catch real
bugs (like the one above) isn't worth the effort compared to just using
a real, tiny, stable target. `test/callSession.test.ts`'s git-tool test
does the same, with `fetch` stubbed for the GitHub metadata call only
(the clone itself also goes through global `fetch`, so the stub passes
through to the real one for anything that isn't the metadata URL).

## Reusing the existing phone number

+1 (607) 365-4321 was originally set up for `ziki-voice-agent` (see that
project's `AGENTS.md` for the full SignalWire/xAI provisioning history --
SIP Gateway resource setup, why SignalWire was chosen over other
providers, etc.). Reusing it here means:

- The SignalWire SIP Gateway resource (`cloudflare.signalwire.com`,
  resource `09f4ed07-2a00-4cd9-84fd-ad6340043177`) doesn't change --
  it just forwards to xAI's fixed SIP endpoint regardless of which
  Worker eventually receives xAI's webhook.
- **There is no in-place update for a phone number's webhook URL.**
  `PATCH /v2/phone-numbers/{id}` rejects an unknown `webhook` field (it
  only accepts `phone_number`/`team_id`/`field_mask`), and re-`POST`ing
  the same `phone_number` 409s with "already connected through Direct
  SIP." The only way found to change it: `DELETE
  /v2/phone-numbers/{id}`, then `POST /v2/phone-numbers` again with the
  same `phone_number` and the new `webhook.url`. This is exactly what
  was done to move +1 (607) 365-4321 from `ziki-voice-agent` to this
  project on 2026-08-08.
- That delete+recreate cycle issues a **brand new**
  `dispatchSigningSecret` in the creation response's `webhook` object --
  it is only ever returned once, at creation, never retrievable via a
  later `GET`. Capture it immediately and set it as `XAI_WEBHOOK_SECRET`
  before doing anything else, or you'll have to delete+recreate again
  just to see it. (Learned the hard way: a `curl | python3 -m json.tool`
  pipeline choked on a stray `-w` flag's output getting concatenated
  onto the JSON, the secret scrolled past, and the phone number had to
  be deleted and recreated a second time just to capture it properly.)
- `ziki-voice-agent` will need its own new number now that this number
  is gone from it. Not yet sourced -- see that project's own
  `AGENTS.md`.

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

## A real bug found on a live call: digest truncation ate all file content

A caller reported the agent could describe a repo's structure but
couldn't say anything about a specific file. Root cause:
`load_repo`'s digest truncation capped the *combined* `summary + tree +
content` string at one budget. A large repo's file tree alone can exceed
that on its own (`cloudflare/computer`'s tree is ~21,600 chars), so the
digest ended up entirely (truncated) tree, with zero file content ever
reaching the model. Fixed by capping the tree (`MAX_TREE_CHARS`) and
content (`MAX_CONTENT_CHARS`) independently in `src/repoTool.ts`, so real
file content always makes it through regardless of tree size. Verified
directly against the real `gitingest.com` response for `cloudflare/computer`
before and after. General lesson: when truncating a concatenation of
several pieces to fit a budget, check whether any single piece can
exceed the *whole* budget on its own -- if so, budget pieces separately.

## Next steps / ideas

- Consider a short-timeout/size-limit audit on the `load_repo` fetches --
  right now a slow or hanging `gitingest.com` response just makes the
  tool call slow; there's no explicit timeout. The same applies to
  `RepoWorkspace`'s clone/pull calls, which can take longer than
  `load_repo` on a repo nobody's asked about yet.
- If `gitingest.com`'s API ever becomes unreliable or disappears, that's
  the thing to replace in `src/repoTool.ts` -- consider GitHub's tree API
  (`git/trees?recursive=1`) plus selective file fetches as a fallback
  that only depends on GitHub itself.
- Consider a rate limit or abuse guard now that this is meant to be
  publicly callable (no `key=`-gated debug/admin routes exist here at
  all, intentionally -- there's nothing to gate). This matters more now
  that a public caller can trigger a real git clone, not just API GETs.
- If cloudflare/computer#89 (short-oid revParse) gets fixed upstream,
  reconsider whether `recentCommits` should go back to short oids for
  nicer spoken/logged output.
- `RepoWorkspace`'s freshness policy (`REFRESH_AFTER_MS`, 15 min) and
  size guard (`MAX_REPO_SIZE_KB`, ~200 MB) are untested guesses about
  what's reasonable for a live phone call -- revisit if either turns out
  to be too aggressive or too loose in practice.
