/**
 * Fetches real information about a public GitHub repository so the voice
 * agent can talk about it instead of guessing from stale training data.
 *
 * Two requests, run in parallel:
 *  - GitHub's REST API for metadata (description, language, stars, etc.)
 *  - gitingest.com's public API (https://github.com/coderamp-labs/gitingest,
 *    15k+ stars) for a pre-filtered digest of the repo's file tree and
 *    contents -- one call gets us "the whole repo, efficiently" instead of
 *    browsing file-by-file. That endpoint isn't an officially documented
 *    public API (it's how gitingest.com's own frontend works), just a
 *    convenient, well-known open-source tool's hosted instance -- fine for
 *    a demo, but a real dependency outside our control. Self-hosting
 *    gitingest (it's Python, distributed as a Docker image) would remove
 *    that dependency at the cost of running a whole extra service, which
 *    is out of scope for keeping this demo simple.
 */

// Separate caps for the tree and the content, not one cap on the
// concatenated blob. A large repo's file tree alone can easily exceed a
// single combined budget (e.g. cloudflare/computer's tree is ~21k chars
// on its own) -- capping the combined string from the start meant the
// digest could end up entirely tree, with zero file content ever
// reaching the model. Budgeting each piece separately guarantees some
// real file content always gets through. A phone call needs a summary
// to talk from, not an entire large repo's source, so both stay small.
const MAX_TREE_CHARS = 2_000;
const MAX_CONTENT_CHARS = 10_000;

export interface RepoInfo {
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  license: string | null;
  topics: string[];
  homepage: string | null;
  defaultBranch: string;
  pushedAt: string | null;
}

export interface RepoContext {
  repo: string;
  info: RepoInfo | null;
  digest: string | null;
  error?: string;
}

/**
 * Best-effort parse of "owner/repo", a full GitHub URL, or a URL with a
 * trailing path (blob/tree/etc.) down to just { owner, repo }.
 */
export function parseRepoSpec(input: string): { owner: string; repo: string } | null {
  const cleaned = input.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  const match = cleaned.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

export async function loadRepoContext(input: string): Promise<RepoContext> {
  const parsed = parseRepoSpec(input);
  if (!parsed) {
    return {
      repo: input,
      info: null,
      digest: null,
      error: `Could not find a GitHub owner/repo in "${input}". Ask the caller for it in "owner/repo" form or as a github.com URL.`,
    };
  }

  const repo = `${parsed.owner}/${parsed.repo}`;
  const [info, digest] = await Promise.all([
    fetchRepoInfo(parsed.owner, parsed.repo),
    fetchDigest(parsed.owner, parsed.repo),
  ]);

  if (!info && !digest) {
    return {
      repo,
      info: null,
      digest: null,
      error: `Could not find a public GitHub repo at "${repo}". It may not exist, may be private, or the name may be misspelled.`,
    };
  }

  return { repo, info, digest };
}

async function fetchRepoInfo(owner: string, repo: string): Promise<RepoInfo | null> {
  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { "User-Agent": "dial-a-repo", Accept: "application/vnd.github+json" },
    });
    if (!resp.ok) return null;

    const data = await resp.json<{
      description: string | null;
      language: string | null;
      stargazers_count: number;
      forks_count: number;
      license: { name: string } | null;
      topics: string[];
      homepage: string | null;
      default_branch: string;
      pushed_at: string | null;
      private: boolean;
    }>();

    if (data.private) return null;

    return {
      description: data.description ?? null,
      language: data.language ?? null,
      stars: data.stargazers_count ?? 0,
      forks: data.forks_count ?? 0,
      license: data.license?.name ?? null,
      topics: data.topics ?? [],
      homepage: data.homepage || null,
      defaultBranch: data.default_branch ?? "main",
      pushedAt: data.pushed_at ?? null,
    };
  } catch {
    return null;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[...truncated for length...]` : text;
}

async function fetchDigest(owner: string, repo: string): Promise<string | null> {
  try {
    // max_file_size (KB) keeps gitingest from pulling in any single huge
    // file; we still truncate tree and content independently below
    // regardless, since the total across all files can still be huge.
    const resp = await fetch(`https://gitingest.com/api/${owner}/${repo}?max_file_size=50`, {
      headers: { "User-Agent": "dial-a-repo" },
    });
    if (!resp.ok) return null;

    const data = await resp.json<{ summary?: string; tree?: string; content?: string }>();
    const parts = [
      data.summary ?? null,
      data.tree ? truncate(data.tree, MAX_TREE_CHARS) : null,
      data.content ? truncate(data.content, MAX_CONTENT_CHARS) : null,
    ].filter((part): part is string => Boolean(part));

    return parts.length > 0 ? parts.join("\n\n") : null;
  } catch {
    return null;
  }
}
