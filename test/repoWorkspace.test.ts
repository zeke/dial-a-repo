import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const HELLO_WORLD_URL = "https://github.com/octocat/Hello-World.git";

describe("RepoWorkspace.ensureCloned", () => {
  it("refuses to clone a repo over the size guard, without touching the network", async () => {
    const stub = env.REPO_WORKSPACE.getByName("test-size-guard");
    const result = await stub.ensureCloned("https://github.com/example/huge.git", "main", 999_999_999);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("too large");
  });
});

// These hit real github.com against a small, effectively frozen public
// repo (octocat/Hello-World, GitHub's own long-standing test fixture) --
// a deliberate exception to this project's usual "stub fetch, no real
// network in tests" rule. A real clone via isomorphic-git has enough
// surface (smart HTTP protocol negotiation, pack parsing, ref resolution)
// that mocking it would either be shallow enough to miss real bugs, or
// complex enough to not be worth it. This is exactly how a real bug was
// found during development: git.revParse doesn't resolve abbreviated oid
// prefixes despite @cloudflare/computer's own docs describing that as
// supported -- see AGENTS.md and the upstream issue linked there.
describe("RepoWorkspace against a real repo (octocat/Hello-World)", () => {
  it("clones, reads commit history, a file, and a diff", async () => {
    const stub = env.REPO_WORKSPACE.getByName("test-octocat-hello-world");

    const cloneResult = await stub.ensureCloned(HELLO_WORLD_URL, "master", 1);
    expect(cloneResult).toEqual({ ok: true });

    const log = await stub.recentCommits(5);
    expect("commits" in log).toBe(true);
    if ("commits" in log) {
      expect(log.commits.length).toBeGreaterThan(0);
      // Full 40-char oids, not abbreviated -- see the revParse note above.
      expect(log.commits[0].oid).toMatch(/^[0-9a-f]{40}$/);
    }

    const file = await stub.fileAt("README", "HEAD");
    expect(file).toEqual({ content: "Hello World!\n" });

    // A real, known commit pair on this repo with an actual content
    // change (adding a trailing newline), using full oids -- see the
    // revParse note above for why not abbreviated ones.
    const diff = await stub.diffRefs(
      "553c2077f0edc3d5dc5d17262f6aa498e69d6f8e",
      "762941318ee16e59dabbacb1b4049eec22f0d303"
    );
    expect("diff" in diff).toBe(true);
    if ("diff" in diff) {
      expect(diff.diff).toContain("README");
    }
  }, 30_000);

  it("reports a clear error for a file that doesn't exist", async () => {
    const stub = env.REPO_WORKSPACE.getByName("test-octocat-hello-world-missing-file");
    await stub.ensureCloned(HELLO_WORLD_URL, "master", 1);
    const file = await stub.fileAt("this-file-does-not-exist.md");
    expect("error" in file).toBe(true);
  }, 30_000);
});
