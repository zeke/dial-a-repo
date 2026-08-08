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
