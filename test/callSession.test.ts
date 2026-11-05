import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallSession } from "../src/callSession";

interface FakeFunctionCallEvent {
  type: string;
  name?: string;
  call_id?: string;
  arguments?: string;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CallSession.handleFunctionCall (load_repo)", () => {
  it("fetches repo context and sends it back as a function_call_output, then response.create", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                description: "A test repo.",
                language: "TypeScript",
                stargazers_count: 1,
                forks_count: 0,
                license: null,
                topics: [],
                homepage: null,
                default_branch: "main",
                pushed_at: null,
                private: false,
              }),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ summary: "s", tree: "t", content: "c" }), { status: 200 })
        );
      })
    );

    const stub = env.CALL_SESSION.getByName("call_test_1");
    const sent: string[] = [];
    const fakeWs = { send: (msg: string) => sent.push(msg) } as unknown as WebSocket;

    await runInDurableObject(stub, (instance: CallSession) => {
      const withPrivate = instance as unknown as {
        handleFunctionCall(ws: WebSocket, callId: string, evt: FakeFunctionCallEvent): void;
      };
      withPrivate.handleFunctionCall(fakeWs, "call_test_1", {
        type: "response.function_call_arguments.done",
        name: "load_repo",
        call_id: "fc_1",
        arguments: JSON.stringify({ repo: "owner/repo" }),
      });
    });

    // handleFunctionCall fires an internal async IIFE it doesn't await --
    // give it a tick to run before asserting on its side effects.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent).toHaveLength(2);
    const [outputMsg, responseCreateMsg] = sent.map((m) => JSON.parse(m) as Record<string, unknown>);
    expect(outputMsg.type).toBe("conversation.item.create");
    const item = outputMsg.item as { call_id: string; output: string };
    expect(item.call_id).toBe("fc_1");
    const output = JSON.parse(item.output) as { repo: string; info: { description: string } | null };
    expect(output.repo).toBe("owner/repo");
    expect(output.info?.description).toBe("A test repo.");
    expect(responseCreateMsg.type).toBe("response.create");
  });

  it("returns an error payload for an unknown function name", async () => {
    const stub = env.CALL_SESSION.getByName("call_test_2");
    const sent: string[] = [];
    const fakeWs = { send: (msg: string) => sent.push(msg) } as unknown as WebSocket;

    await runInDurableObject(stub, (instance: CallSession) => {
      const withPrivate = instance as unknown as {
        handleFunctionCall(ws: WebSocket, callId: string, evt: FakeFunctionCallEvent): void;
      };
      withPrivate.handleFunctionCall(fakeWs, "call_test_2", {
        type: "response.function_call_arguments.done",
        name: "not_a_real_tool",
        call_id: "fc_2",
        arguments: "{}",
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const [outputMsg] = sent.map((m) => JSON.parse(m) as Record<string, unknown>);
    const item = outputMsg.item as { output: string };
    const output = JSON.parse(item.output) as { error: string };
    expect(output.error).toContain("not_a_real_tool");
  });
});

// Exercises the full dispatch path for the git-backed tools: resolving
// the repo, cloning it via the real REPO_WORKSPACE Durable Object, and
// returning real results -- against a small, effectively frozen public
// repo (see repoWorkspace.test.ts for why this one hits real network
// instead of stubbing it).
describe("CallSession.handleFunctionCall (git-backed tools)", () => {
  it("runs repo_recent_commits against a real clone", async () => {
    // isomorphic-git's clone also goes through global fetch, not a
    // separate transport -- so this stub has to pass through to the real
    // fetch for anything that isn't the GitHub metadata lookup, or the
    // clone itself would 404 against our own stub.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                description: null,
                language: null,
                stargazers_count: 0,
                forks_count: 0,
                license: null,
                topics: [],
                homepage: null,
                default_branch: "master",
                pushed_at: null,
                private: false,
                size: 1,
              }),
              { status: 200 }
            )
          );
        }
        return realFetch(input, init);
      })
    );

    const stub = env.CALL_SESSION.getByName("call_test_git_tools");
    const sent: string[] = [];
    const fakeWs = { send: (msg: string) => sent.push(msg) } as unknown as WebSocket;

    await runInDurableObject(stub, (instance: CallSession) => {
      const withPrivate = instance as unknown as {
        handleFunctionCall(ws: WebSocket, callId: string, evt: FakeFunctionCallEvent): void;
      };
      withPrivate.handleFunctionCall(fakeWs, "call_test_git_tools", {
        type: "response.function_call_arguments.done",
        name: "repo_recent_commits",
        call_id: "fc_3",
        arguments: JSON.stringify({ repo: "octocat/Hello-World", limit: 3 }),
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 2_000));

    expect(sent).toHaveLength(2);
    const [outputMsg] = sent.map((m) => JSON.parse(m) as Record<string, unknown>);
    const item = outputMsg.item as { output: string };
    const output = JSON.parse(item.output) as { commits?: { oid: string; message: string }[]; error?: string };
    expect(output.commits?.length).toBeGreaterThan(0);
    expect(output.commits?.[0].oid).toMatch(/^[0-9a-f]{40}$/);
  }, 30_000);
});

describe("CallSession end_call", () => {
  it("hangs up after the goodbye grace period without prompting another response", async () => {
    const hangups: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        hangups.push(String(input));
        return Promise.resolve(new Response("{}", { status: 200 }));
      })
    );
    vi.useFakeTimers();
    try {
      const stub = env.CALL_SESSION.getByName("call_test_end_call");
      const sent: string[] = [];
      let closed = false;
      const fakeWs = {
        send: (msg: string) => sent.push(msg),
        close: () => {
          closed = true;
        },
      } as unknown as WebSocket;

      await runInDurableObject(stub, async (instance: CallSession) => {
        const withPrivate = instance as unknown as {
          handleFunctionCall(ws: WebSocket, callId: string, evt: FakeFunctionCallEvent): void;
        };
        withPrivate.handleFunctionCall(fakeWs, "call_end_1", {
          type: "response.function_call_arguments.done",
          name: "end_call",
          call_id: "fc_end",
          arguments: "{}",
        });
        expect(hangups).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(6_000);
      });

      expect(sent).toHaveLength(0);
      expect(hangups).toEqual(["https://api.x.ai/v1/realtime/calls/call_end_1/hangup"]);
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CallSession.run over budget", () => {
  it("plays the limit message and hangs up without starting a normal session", async () => {
    await env.CALL_BUDGET.getByName("+15550000001").record(60 * 60);

    const hangups: string[] = [];
    const received: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/hangup")) {
          hangups.push(url);
          return Promise.resolve(new Response("{}", { status: 200 }));
        }
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.accept();
        server.addEventListener("message", (msg: MessageEvent) => {
          received.push(JSON.parse(msg.data as string) as Record<string, unknown>);
        });
        return Promise.resolve(new Response(null, { status: 101, webSocket: client }));
      })
    );

    const stub = env.CALL_SESSION.getByName("call_test_over_budget");
    await runInDurableObject(stub, (instance: CallSession) => instance.run("call_over_1", "+15550000001"));

    expect(hangups).toEqual(["https://api.x.ai/v1/realtime/calls/call_over_1/hangup"]);
    const session = received.find((m) => m.type === "session.update")?.session as { tools: unknown[] };
    expect(session.tools).toEqual([]);
    const spoken = received
      .filter((m) => m.type === "conversation.item.create")
      .map((m) => JSON.stringify(m.item));
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain("daily time limit");
  }, 15_000);
});

describe("CallSession.run within budget", () => {
  it("starts a normal session and records the call's duration against both ledgers", async () => {
    const received: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.accept();
        server.addEventListener("message", (msg: MessageEvent) => {
          received.push(JSON.parse(msg.data as string) as Record<string, unknown>);
        });
        // The caller hangs up shortly after the greeting.
        setTimeout(() => server.close(1000, "bye"), 50);
        return Promise.resolve(new Response(null, { status: 101, webSocket: client }));
      })
    );

    const globalBefore = await env.CALL_BUDGET.getByName("global").remaining(120 * 60);
    const stub = env.CALL_SESSION.getByName("call_test_normal");
    await runInDurableObject(stub, (instance: CallSession) => instance.run("call_normal_1", "+15550000002"));

    const session = received.find((m) => m.type === "session.update")?.session as { tools: { name: string }[] };
    expect(session.tools.map((t) => t.name)).toContain("end_call");
    expect(JSON.stringify(received.find((m) => m.type === "conversation.item.create"))).toContain("GitHub repo");

    expect(await env.CALL_BUDGET.getByName("+15550000002").remaining(20 * 60)).toBe(20 * 60 - 1);
    expect(await env.CALL_BUDGET.getByName("global").remaining(120 * 60)).toBe(globalBefore - 1);
  });
});
