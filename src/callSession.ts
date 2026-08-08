import { DurableObject } from "cloudflare:workers";
import { loadRepoContext, resolveCloneTarget } from "./repoTool";

const DEFAULT_REPO = "cloudflare/computer";
const OWN_REPO = "zeke/dial-a-repo";

const GREETING =
  "Hi, this is Dial-a-Repo. Tell me the name of a public GitHub repo -- like \"owner slash repo\", " +
  "or just a project name -- and I'll dig in and tell you what it's about. Or stay quiet and " +
  `I'll tell you about ${DEFAULT_REPO}.`;

const BASE_INSTRUCTIONS = `You are "Dial-a-Repo," a voice assistant that helps callers explore and
understand public GitHub repositories over the phone. This is a phone call, not a chat window --
keep responses short, spoken, and conversational.

Your own source code lives at "${OWN_REPO}". If the caller asks about you, this project, how you
work, or what your own code looks like, that's the repo to load -- don't describe yourself from
memory, look yourself up like any other repo.

When a caller mentions a GitHub repository -- a URL, "owner/repo", or a project name you can guess
the repo slug for -- call the load_repo tool to fetch real, current data about it: its description,
language, and a digest of its actual file structure and contents. Base what you say on that data.
Your training data about any specific repo may be stale or wrong, so don't describe a repo's
internals from memory alone once you have real tool data to work from.

You also have three tools backed by a real git clone of the repo, for going deeper than
load_repo's digest:

- repo_recent_commits -- recent commit history. Use it for "what changed recently," "what's new,"
  or "what happened in the last commit / week / month."
- repo_file -- the full content of one specific file (not truncated the way load_repo's digest
  might be). Use it when the caller asks about a particular file and load_repo's digest didn't
  have enough, or didn't include it at all.
- repo_diff -- a diff between two commits. Use it for "what changed in that commit" or "show me
  the difference between X and Y."

These three need to clone the repo first, which can take a few seconds longer than load_repo on a
repo nobody's asked about yet -- say something like "let me check the git history" before calling
one, so the pause makes sense to the caller.

Say something short like "Let me pull that up" before or while calling any tool, so the caller
knows you're fetching real data and there may be a brief pause.

If the caller doesn't mention any repo -- they're unsure what to ask, say something vague like
"I don't know" or "you choose," or just stay silent after the greeting -- use "${DEFAULT_REPO}"
(a real Cloudflare project) as the default. Don't ask permission first, just say something like
"I'll tell you about ${DEFAULT_REPO} then" and call load_repo with it.

If a tool returns an error (repo not found, private, misspelled, or too large to clone), say so
plainly and ask the caller to repeat or clarify -- don't invent details instead.

Talk like a knowledgeable, friendly engineer explaining a codebase to a colleague: what the project
is for, what language and stack it uses, how it's structured, and how it works at a high level.
Don't read the file tree, file contents, or diffs verbatim -- summarize them in your own words.

Be concise. No filler, no padding, no over-explaining. Casual and informal language is fine. Do not
be cute, overly friendly, or sound like a customer service agent.

If you don't know something and no tool provided it, say so plainly instead of guessing.`;

const REPO_ARG = {
  type: "string" as const,
  description:
    "The repo, as \"owner/repo\" or a github.com URL, e.g. \"cloudflare/workers-sdk\" or " +
    "\"https://github.com/cloudflare/workers-sdk\".",
};

const TOOLS = [
  {
    type: "function" as const,
    name: "load_repo",
    description:
      "Fetch real data about a public GitHub repository: description, language, stars, and a " +
      "digest of its file structure and contents. Call this whenever the caller mentions a repo, " +
      "before describing what it is or how it works.",
    parameters: {
      type: "object",
      properties: { repo: REPO_ARG },
      required: ["repo"],
    },
  },
  {
    type: "function" as const,
    name: "repo_recent_commits",
    description:
      "Recent commit history from a real clone of the repo. Use `sinceDays` for a time window " +
      "(\"what changed in the last month\"), or `limit` for a fixed count (\"the last 3 commits\").",
    parameters: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        limit: { type: "number", description: "Max commits to return when not using sinceDays. Default 10." },
        sinceDays: { type: "number", description: "Only commits from this many days ago to now." },
      },
      required: ["repo"],
    },
  },
  {
    type: "function" as const,
    name: "repo_file",
    description:
      "Full content of one specific file from a real clone of the repo, at HEAD or a given ref. " +
      "Use this when load_repo's digest didn't include enough of a file the caller asked about.",
    parameters: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        path: { type: "string", description: "Repo-relative file path, e.g. \"src/index.ts\"." },
        ref: { type: "string", description: "Commit, branch, or tag to read the file at. Defaults to HEAD." },
      },
      required: ["repo", "path"],
    },
  },
  {
    type: "function" as const,
    name: "repo_diff",
    description:
      "Unified diff between two refs in a real clone of the repo. For \"what changed in the last " +
      "commit,\" use from=\"HEAD~1\" and leave to unset (defaults to HEAD).",
    parameters: {
      type: "object",
      properties: {
        repo: REPO_ARG,
        from: { type: "string", description: "Starting ref, e.g. \"HEAD~1\" or a commit oid." },
        to: { type: "string", description: "Ending ref. Defaults to HEAD." },
        path: { type: "string", description: "Limit the diff to one file, if given." },
      },
      required: ["repo", "from"],
    },
  },
];

/**
 * Loose shape covering only the realtime event fields we actually read.
 * The Voice Agent API has many event types with different payloads; this
 * isn't exhaustive, just enough to type-check our own access.
 */
interface RealtimeEvent {
  type: string;
  transcript?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  [key: string]: unknown;
}

/** Reads a string field out of parsed tool-call arguments, or "" if absent/wrong-typed. */
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Holds the outbound WebSocket bridge to xAI's Realtime API for a single
 * phone call. Runs inside a Durable Object rather than a plain Worker
 * fetch handler because ctx.waitUntil() in a normal Worker has a limited
 * execution budget (calls were getting cut off around 30s) -- a Durable
 * Object instance stays alive independently as long as it has active
 * work. One instance per call_id -- this project doesn't persist
 * conversation history across calls, see the "Extra credit" section of
 * the README for that and other features intentionally left out of this
 * demo. Real git clones (see repoWorkspace.ts), on the other hand, are
 * cached per-repo in a separate Durable Object and do persist across
 * calls, since they're expensive to produce and cheap to reuse.
 */
export class CallSession extends DurableObject<Env> {
  async run(callId: string): Promise<void> {
    const wsUrl = `https://api.x.ai/v1/realtime?call_id=${encodeURIComponent(callId)}`;

    const resp = await fetch(wsUrl, {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${this.env.XAI_API_KEY}`,
      },
    });

    const ws = resp.webSocket;
    if (!ws) {
      console.error(JSON.stringify({ msg: "no_websocket", call_id: callId, status: resp.status }));
      return;
    }

    ws.accept();

    // The WebSocket returned from an outbound fetch() upgrade is already
    // open -- there is no subsequent "open" event to wait for. Send our
    // initial messages immediately.
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          voice: "celeste", // "Compassionate, confident, and reassuring" per xAI's voice table
          instructions: BASE_INSTRUCTIONS,
          turn_detection: { type: "server_vad" },
          tools: TOOLS,
          audio: { input: { transcription: { model: "grok-transcribe" } } },
        },
      })
    );

    // Deliver the greeting as a force_message: a hard-coded, TTS-
    // synthesized line played verbatim without the model deciding what
    // to say. This is an xAI extension distinct from
    // conversation.item.create for normal turns -- the force_message IS
    // the turn, so we must NOT also send response.create for it (that
    // would trigger a second, model-generated turn on top of the
    // scripted one). Prompting the model to "say exactly X" instead is
    // unreliable in practice -- it tends to tack on extra filler.
    ws.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "force_message",
          role: "assistant",
          content: [{ type: "output_text", text: GREETING }],
        },
      })
    );

    await new Promise<void>((resolve) => {
      ws.addEventListener("message", (msg: MessageEvent) => {
        try {
          const evt = JSON.parse(msg.data as string) as RealtimeEvent;
          if (evt.type === "error") {
            console.error(JSON.stringify({ msg: "xai_error", call_id: callId, event: evt }));
          } else if (evt.type === "response.function_call_arguments.done") {
            this.handleFunctionCall(ws, callId, evt);
          } else if (
            evt.type !== "response.output_audio.delta" &&
            evt.type !== "response.output_audio_transcript.delta"
          ) {
            // Avoid logging every audio chunk; log everything else for
            // debugging, including transcript text when the event
            // carries one, so live conversations show up in
            // `wrangler tail`.
            console.log(
              JSON.stringify({ msg: "xai_event", call_id: callId, type: evt.type, transcript: evt.transcript })
            );
          }
        } catch {
          // ignore malformed frames
        }
      });

      ws.addEventListener("close", () => {
        console.log(JSON.stringify({ msg: "call_ended", call_id: callId }));
        resolve();
      });

      ws.addEventListener("error", (err: Event) => {
        console.error(JSON.stringify({ msg: "ws_error", call_id: callId, error: err.type }));
        resolve();
      });
    });
  }

  /**
   * Dispatches a tool call to the matching handler and feeds the result
   * back to the model.
   *
   * xAI emits response.function_call_arguments.done with { name, call_id,
   * arguments }; we run it, reply with a function_call_output conversation
   * item, then response.create so the agent speaks the result. Fired from
   * a synchronous message listener, so it manages its own promise.
   */
  private handleFunctionCall(ws: WebSocket, callId: string, evt: RealtimeEvent): void {
    const { name, call_id: fnCallId, arguments: argsJson } = evt;
    void (async () => {
      let output: string;
      try {
        const args = JSON.parse(argsJson ?? "{}") as Record<string, unknown>;
        switch (name) {
          case "load_repo":
            output = JSON.stringify(await this.runLoadRepo(args));
            break;
          case "repo_recent_commits":
            output = JSON.stringify(await this.runRecentCommits(args));
            break;
          case "repo_file":
            output = JSON.stringify(await this.runRepoFile(args));
            break;
          case "repo_diff":
            output = JSON.stringify(await this.runRepoDiff(args));
            break;
          default:
            output = JSON.stringify({ error: `unknown function ${name}` });
        }
        console.log(JSON.stringify({ msg: "tool_call", call_id: callId, name }));
      } catch (err) {
        console.error(JSON.stringify({ msg: "tool_call_error", call_id: callId, name, error: String(err) }));
        output = JSON.stringify({ error: String(err) });
      }
      ws.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: fnCallId, output },
        })
      );
      ws.send(JSON.stringify({ type: "response.create" }));
    })();
  }

  private async runLoadRepo(args: Record<string, unknown>) {
    const repo = str(args.repo);
    if (!repo) return { error: "missing repo" };
    return loadRepoContext(repo);
  }

  /**
   * Shared by the three git-backed tools: resolves the repo, ensures its
   * RepoWorkspace clone is present and fresh, and returns a stub to call
   * further RPC methods on. Returns an error payload (never throws) if
   * resolution or cloning fails, so callers can return it directly.
   */
  private async getRepoWorkspace(repoInput: string) {
    const resolved = await resolveCloneTarget(repoInput);
    if (!resolved.ok) return { ok: false as const, error: resolved.error };

    const stub = this.env.REPO_WORKSPACE.get(this.env.REPO_WORKSPACE.idFromName(resolved.target.repo));
    const cloneResult = await stub.ensureCloned(
      resolved.target.cloneUrl,
      resolved.target.defaultBranch,
      resolved.target.sizeKb
    );
    if (!cloneResult.ok) return { ok: false as const, error: cloneResult.error };

    return { ok: true as const, stub };
  }

  private async runRecentCommits(args: Record<string, unknown>) {
    const repo = str(args.repo);
    if (!repo) return { error: "missing repo" };
    const workspace = await this.getRepoWorkspace(repo);
    if (!workspace.ok) return { error: workspace.error };

    const limit = typeof args.limit === "number" ? args.limit : 10;
    const sinceDays = typeof args.sinceDays === "number" ? args.sinceDays : undefined;
    return workspace.stub.recentCommits(limit, sinceDays);
  }

  private async runRepoFile(args: Record<string, unknown>) {
    const repo = str(args.repo);
    const path = str(args.path);
    if (!repo || !path) return { error: "missing repo or path" };
    const workspace = await this.getRepoWorkspace(repo);
    if (!workspace.ok) return { error: workspace.error };

    const ref = str(args.ref) || undefined;
    return workspace.stub.fileAt(path, ref);
  }

  private async runRepoDiff(args: Record<string, unknown>) {
    const repo = str(args.repo);
    const from = str(args.from);
    if (!repo || !from) return { error: "missing repo or from" };
    const workspace = await this.getRepoWorkspace(repo);
    if (!workspace.ok) return { error: workspace.error };

    const to = str(args.to) || undefined;
    const path = str(args.path) || undefined;
    return workspace.stub.diffRefs(from, to, path);
  }
}
