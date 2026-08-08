import { DurableObject } from "cloudflare:workers";
import { loadRepoContext } from "./repoTool";

const DEFAULT_REPO = "cloudflare/computer";

const GREETING =
  "Hi, this is Dial-a-Repo. Tell me the name of a public GitHub repo -- like \"owner slash repo\", " +
  "or just a project name -- and I'll dig in and tell you what it's about. Or stay quiet and " +
  `I'll tell you about ${DEFAULT_REPO}.`;

const BASE_INSTRUCTIONS = `You are "Dial-a-Repo," a voice assistant that helps callers explore and
understand public GitHub repositories over the phone. This is a phone call, not a chat window --
keep responses short, spoken, and conversational.

When a caller mentions a GitHub repository -- a URL, "owner/repo", or a project name you can guess
the repo slug for -- call the load_repo tool to fetch real, current data about it: its description,
language, and a digest of its actual file structure and contents. Base what you say on that data.
Your training data about any specific repo may be stale or wrong, so don't describe a repo's
internals from memory alone once you have real tool data to work from.

Say something short like "Let me pull that up" before or while calling the tool, so the caller
knows you're fetching real data and there may be a brief pause.

If the caller doesn't mention any repo -- they're unsure what to ask, say something vague like
"I don't know" or "you choose," or just stay silent after the greeting -- use "${DEFAULT_REPO}"
(a real Cloudflare project) as the default. Don't ask permission first, just say something like
"I'll tell you about ${DEFAULT_REPO} then" and call load_repo with it.

If the tool returns an error (repo not found, private, or misspelled), say so plainly and ask the
caller to repeat or clarify the name -- don't invent details instead.

Talk like a knowledgeable, friendly engineer explaining a codebase to a colleague: what the project
is for, what language and stack it uses, how it's structured, and how it works at a high level.
Don't read the file tree or file contents verbatim -- summarize them in your own words.

Be concise. No filler, no padding, no over-explaining. Casual and informal language is fine. Do not
be cute, overly friendly, or sound like a customer service agent.

If you don't know something and the tool didn't provide it, say so plainly instead of guessing.`;

const LOAD_REPO_TOOL = {
  type: "function" as const,
  name: "load_repo",
  description:
    "Fetch real data about a public GitHub repository: description, language, stars, and a " +
    "digest of its file structure and contents. Call this whenever the caller mentions a repo, " +
    "before describing what it is or how it works.",
  parameters: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description:
          "The repo the caller mentioned, as \"owner/repo\" or a github.com URL, e.g. " +
          "\"cloudflare/workers-sdk\" or \"https://github.com/cloudflare/workers-sdk\".",
      },
    },
    required: ["repo"],
  },
};

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

/**
 * Holds the outbound WebSocket bridge to xAI's Realtime API for a single
 * phone call. Runs inside a Durable Object rather than a plain Worker
 * fetch handler because ctx.waitUntil() in a normal Worker has a limited
 * execution budget (calls were getting cut off around 30s) -- a Durable
 * Object instance stays alive independently as long as it has active
 * work. One instance per call_id -- this project doesn't persist
 * anything across calls, see the "Extra credit" section of the README
 * for that and other features intentionally left out of this demo.
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
          voice: "eve",
          instructions: BASE_INSTRUCTIONS,
          turn_detection: { type: "server_vad" },
          tools: [LOAD_REPO_TOOL],
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
   * Runs the load_repo tool and feeds the result back to the model.
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
        if (name === "load_repo") {
          const args = JSON.parse(argsJson ?? "{}") as { repo?: string };
          const repo = String(args.repo ?? "").trim();
          if (!repo) throw new Error("missing repo");
          const context = await loadRepoContext(repo);
          console.log(JSON.stringify({ msg: "load_repo", call_id: callId, repo, error: context.error }));
          output = JSON.stringify(context);
        } else {
          output = JSON.stringify({ error: `unknown function ${name}` });
        }
      } catch (err) {
        console.error(JSON.stringify({ msg: "load_repo_error", call_id: callId, error: String(err) }));
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
}
