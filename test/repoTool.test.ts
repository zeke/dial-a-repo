import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRepoContext, parseRepoSpec } from "../src/repoTool";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseRepoSpec", () => {
  it("parses owner/repo", () => {
    expect(parseRepoSpec("cloudflare/workers-sdk")).toEqual({ owner: "cloudflare", repo: "workers-sdk" });
  });

  it("parses a full github.com URL", () => {
    expect(parseRepoSpec("https://github.com/cloudflare/workers-sdk")).toEqual({
      owner: "cloudflare",
      repo: "workers-sdk",
    });
  });

  it("parses a github.com URL with a trailing path", () => {
    expect(parseRepoSpec("https://github.com/cloudflare/workers-sdk/tree/main/packages")).toEqual({
      owner: "cloudflare",
      repo: "workers-sdk",
    });
  });

  it("strips a trailing .git", () => {
    expect(parseRepoSpec("cloudflare/workers-sdk.git")).toEqual({ owner: "cloudflare", repo: "workers-sdk" });
  });

  it("returns null for input with no slash", () => {
    expect(parseRepoSpec("not-a-repo")).toBeNull();
  });
});

describe("loadRepoContext", () => {
  it("returns an error for unparseable input", async () => {
    const context = await loadRepoContext("not-a-repo");
    expect(context.error).toContain("not-a-repo");
    expect(context.info).toBeNull();
    expect(context.digest).toBeNull();
  });

  it("combines GitHub metadata and a gitingest digest", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                description: "A CLI and SDK for Cloudflare Workers.",
                language: "TypeScript",
                stargazers_count: 3000,
                forks_count: 500,
                license: { name: "MIT License" },
                topics: ["cloudflare", "workers"],
                homepage: "https://workers.cloudflare.com",
                default_branch: "main",
                pushed_at: "2026-01-01T00:00:00Z",
                private: false,
              }),
              { status: 200 }
            )
          );
        }
        if (url.startsWith("https://gitingest.com/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                summary: "Repository: cloudflare/workers-sdk",
                tree: "Directory structure:\n└── workers-sdk/\n    └── README.md\n",
                content: "FILE: README.md\n\nWorkers SDK.",
              }),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      })
    );

    const context = await loadRepoContext("https://github.com/cloudflare/workers-sdk");
    expect(context.repo).toBe("cloudflare/workers-sdk");
    expect(context.error).toBeUndefined();
    expect(context.info).toEqual({
      description: "A CLI and SDK for Cloudflare Workers.",
      language: "TypeScript",
      stars: 3000,
      forks: 500,
      license: "MIT License",
      topics: ["cloudflare", "workers"],
      homepage: "https://workers.cloudflare.com",
      defaultBranch: "main",
      pushedAt: "2026-01-01T00:00:00Z",
    });
    expect(context.digest).toContain("workers-sdk");
  });

  it("returns an error when the repo doesn't exist on either source", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("not found", { status: 404 })))
    );

    const context = await loadRepoContext("nobody/nothing");
    expect(context.info).toBeNull();
    expect(context.digest).toBeNull();
    expect(context.error).toContain("nobody/nothing");
  });

  it("truncates an oversized digest", async () => {
    const hugeContent = "x".repeat(20_000);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.startsWith("https://gitingest.com/")) {
          return Promise.resolve(new Response(JSON.stringify({ content: hugeContent }), { status: 200 }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      })
    );

    const context = await loadRepoContext("owner/repo");
    expect(context.digest).not.toBeNull();
    expect(context.digest!.length).toBeLessThan(hugeContent.length);
    expect(context.digest).toContain("[...truncated for length...]");
  });
});
