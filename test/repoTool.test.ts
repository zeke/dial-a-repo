import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRepoContext, parseRepoSpec, resolveCloneTarget } from "../src/repoTool";

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
                size: 4096,
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
      sizeKb: 4096,
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

  it("still includes file content when the tree alone exceeds the old combined budget", async () => {
    // Regression test for the real bug found live: a large repo's tree can
    // exceed a single combined char budget on its own, which meant
    // truncating the concatenated blob left zero file content in the
    // digest -- the model could describe structure but not any file's
    // contents. Tree and content must be budgeted independently.
    const hugeTree = "file.ts\n".repeat(3_000); // ~24,000 chars, alone bigger than the old 12,000 cap
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.startsWith("https://gitingest.com/")) {
          return Promise.resolve(
            new Response(JSON.stringify({ tree: hugeTree, content: "FILE: README.md\n\nHello." }), {
              status: 200,
            })
          );
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      })
    );

    const context = await loadRepoContext("owner/repo");
    expect(context.digest).toContain("FILE: README.md");
    expect(context.digest).toContain("Hello.");
  });
});

describe("resolveCloneTarget", () => {
  it("returns a clone URL, default branch, and size for a real-looking repo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              description: null,
              language: "TypeScript",
              stargazers_count: 1,
              forks_count: 0,
              license: null,
              topics: [],
              homepage: null,
              default_branch: "trunk",
              pushed_at: null,
              private: false,
              size: 1234,
            }),
            { status: 200 }
          )
        )
      )
    );

    const result = await resolveCloneTarget("owner/repo");
    expect(result).toEqual({
      ok: true,
      target: {
        repo: "owner/repo",
        cloneUrl: "https://github.com/owner/repo.git",
        defaultBranch: "trunk",
        sizeKb: 1234,
      },
    });
  });

  it("returns an error for input with no owner/repo", async () => {
    const result = await resolveCloneTarget("not-a-repo");
    expect(result.ok).toBe(false);
  });

  it("returns an error when the repo doesn't exist", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("not found", { status: 404 }))));
    const result = await resolveCloneTarget("nobody/nothing");
    expect(result.ok).toBe(false);
  });
});
