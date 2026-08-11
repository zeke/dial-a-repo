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
  it("returns an error when a bare name matches no repo via search", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/search/repositories")) {
          return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      })
    );

    const context = await loadRepoContext("not-a-repo");
    expect(context.error).toContain("not-a-repo");
    expect(context.info).toBeNull();
    expect(context.digest).toBeNull();
  });

  it("resolves a bare project name to the top matching repo via search", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/search/repositories")) {
          expect(url).toContain("react");
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [
                  {
                    name: "react",
                    full_name: "react/react",
                    description: "The library for web and native user interfaces.",
                    language: "JavaScript",
                    stargazers_count: 247_000,
                    forks_count: 50_000,
                    license: { name: "MIT License" },
                    topics: ["react"],
                    homepage: "https://react.dev",
                    default_branch: "main",
                    pushed_at: "2026-01-01T00:00:00Z",
                    private: false,
                    size: 5000,
                  },
                ],
              }),
              { status: 200 }
            )
          );
        }
        if (url.startsWith("https://gitingest.com/")) {
          return Promise.resolve(new Response(JSON.stringify({ summary: "Repository: react/react" }), { status: 200 }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      })
    );

    const context = await loadRepoContext("react");
    expect(context.repo).toBe("react/react");
    expect(context.error).toBeUndefined();
    expect(context.info?.stars).toBe(247_000);
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

  it("returns an error for a bare name that matches no repo via search", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/search/repositories")) {
          return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      })
    );

    const result = await resolveCloneTarget("not-a-repo");
    expect(result.ok).toBe(false);
  });

  it("resolves a bare project name via search for cloning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/search/repositories")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [
                  {
                    name: "vite",
                    full_name: "vitejs/vite",
                    description: null,
                    language: "TypeScript",
                    stargazers_count: 82_000,
                    forks_count: 8_000,
                    license: null,
                    topics: [],
                    homepage: null,
                    default_branch: "main",
                    pushed_at: null,
                    private: false,
                    size: 73_000,
                  },
                ],
              }),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      })
    );

    const result = await resolveCloneTarget("vite");
    expect(result).toEqual({
      ok: true,
      target: {
        repo: "vitejs/vite",
        cloneUrl: "https://github.com/vitejs/vite.git",
        defaultBranch: "main",
        sizeKb: 73_000,
      },
    });
  });

  it("returns an error when the repo doesn't exist", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("not found", { status: 404 }))));
    const result = await resolveCloneTarget("nobody/nothing");
    expect(result.ok).toBe(false);
  });

  it("refuses a low-star, non-exact search match instead of describing it confidently", async () => {
    // Regression test for a real failure: a caller described a project
    // ("the Py coding agent") rather than naming it exactly. The search
    // matched a 22-star repo on loose token overlap, which the agent then
    // described as if it were correct. A non-exact match below the star
    // threshold should be treated as "no confident match" instead.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                {
                  name: "Python-coding-Agent",
                  full_name: "someone/Python-coding-Agent",
                  description: null,
                  language: "Python",
                  stargazers_count: 22,
                  forks_count: 1,
                  license: null,
                  topics: [],
                  homepage: null,
                  default_branch: "main",
                  pushed_at: null,
                  private: false,
                  size: 100,
                },
              ],
            }),
            { status: 200 }
          )
        )
      )
    );

    const context = await loadRepoContext("the Py coding agent");
    expect(context.info).toBeNull();
    expect(context.error).toContain("Python-coding-Agent");
    expect(context.error).toContain("22");

    const cloneResult = await resolveCloneTarget("the Py coding agent");
    expect(cloneResult.ok).toBe(false);
  });

  it("uses web search to resolve a description GitHub search gets wrong", async () => {
    // GitHub search only matches on the repo name, so a vague description
    // ("the pi coding agent") lands on a low-star, wrong repo. The
    // github.com-scoped web search finds the real one, which then gets
    // verified against the GitHub API before we trust it.
    let webSearchScopedToGitHub = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/search/repositories")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [
                  {
                    name: "pi-coding-agent",
                    full_name: "someone/pi-coding-agent",
                    stargazers_count: 12,
                    forks_count: 0,
                    private: false,
                    default_branch: "main",
                    size: 50,
                    topics: [],
                    license: null,
                  },
                ],
              }),
              { status: 200 }
            )
          );
        }
        if (url === "https://api.x.ai/v1/responses") {
          const body = JSON.parse(init?.body as string) as {
            tools?: { filters?: { allowed_domains?: string[] } }[];
          };
          webSearchScopedToGitHub = body.tools?.[0]?.filters?.allowed_domains?.includes("github.com") ?? false;
          return Promise.resolve(
            new Response(
              JSON.stringify({ output: [{ content: [{ type: "output_text", text: "earendil-works/pi" }] }] }),
              { status: 200 }
            )
          );
        }
        if (url === "https://api.github.com/repos/earendil-works/pi") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                description: "The pi coding agent.",
                stargazers_count: 85_000,
                forks_count: 1_000,
                private: false,
                default_branch: "main",
                size: 3000,
                topics: [],
                license: null,
              }),
              { status: 200 }
            )
          );
        }
        if (url.startsWith("https://gitingest.com/")) {
          return Promise.resolve(new Response(JSON.stringify({ summary: "Repository: earendil-works/pi" }), { status: 200 }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      })
    );

    const context = await loadRepoContext("the pi coding agent", "test-key");
    expect(context.repo).toBe("earendil-works/pi");
    expect(context.info?.stars).toBe(85_000);
    expect(webSearchScopedToGitHub).toBe(true);
  });

  it("prefers an exact GitHub name match over web search", async () => {
    // An exact name match is unambiguous and free -- it should win
    // without ever trusting (or verifying) the web-search result.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/search/repositories")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [
                  {
                    name: "vite",
                    full_name: "vitejs/vite",
                    stargazers_count: 82_000,
                    forks_count: 8_000,
                    private: false,
                    default_branch: "main",
                    size: 73_000,
                    topics: [],
                    license: null,
                  },
                ],
              }),
              { status: 200 }
            )
          );
        }
        if (url === "https://api.x.ai/v1/responses") {
          return Promise.resolve(new Response(JSON.stringify({ output_text: "impostor/vite" }), { status: 200 }));
        }
        if (url === "https://api.github.com/repos/impostor/vite") {
          throw new Error("should not verify the web-search result when an exact match exists");
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      })
    );

    const result = await resolveCloneTarget("vite", "test-key");
    expect(result).toMatchObject({ ok: true, target: { repo: "vitejs/vite" } });
  });

  it("ignores a web-search result that doesn't exist on GitHub", async () => {
    // The web search can name a repo that's moved or hallucinated -- if
    // the GitHub API can't confirm it, fall back to GitHub's own top hit.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/search/repositories")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [
                  {
                    name: "something-else",
                    full_name: "real/something-else",
                    stargazers_count: 5_000,
                    forks_count: 100,
                    private: false,
                    default_branch: "main",
                    size: 200,
                    topics: [],
                    license: null,
                  },
                ],
              }),
              { status: 200 }
            )
          );
        }
        if (url === "https://api.x.ai/v1/responses") {
          return Promise.resolve(new Response(JSON.stringify({ output_text: "ghost/missing" }), { status: 200 }));
        }
        if (url === "https://api.github.com/repos/ghost/missing") {
          return Promise.resolve(new Response("not found", { status: 404 }));
        }
        if (url.startsWith("https://gitingest.com/")) {
          return Promise.resolve(new Response(JSON.stringify({ summary: "x" }), { status: 200 }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      })
    );

    const context = await loadRepoContext("some vague thing", "test-key");
    expect(context.repo).toBe("real/something-else");
  });

  it("still accepts a low-star repo if its name matches exactly", async () => {
    // A small but exactly-named repo is still clearly what the caller
    // meant -- the star threshold only applies to non-exact matches.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                {
                  name: "tinyrepo",
                  full_name: "someone/tinyrepo",
                  description: null,
                  language: null,
                  stargazers_count: 3,
                  forks_count: 0,
                  license: null,
                  topics: [],
                  homepage: null,
                  default_branch: "main",
                  pushed_at: null,
                  private: false,
                  size: 10,
                },
              ],
            }),
            { status: 200 }
          )
        )
      )
    );

    const context = await loadRepoContext("tinyrepo");
    expect(context.repo).toBe("someone/tinyrepo");
    expect(context.info?.stars).toBe(3);
  });
});
