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
  sizeKb: number;
}

export interface CloneTarget {
  repo: string;
  cloneUrl: string;
  defaultBranch: string;
  sizeKb: number;
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
  if (parsed) {
    // Direct owner/repo (or URL): fetch metadata and digest in parallel,
    // and tolerate either one failing on its own -- a digest with no
    // metadata (or vice versa) is still useful to hand back.
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

  // Bare project name (no "/") -- resolve via search first, which
  // already returns full metadata, then fetch the digest for it.
  const found = await searchRepoByName(input);
  if (!found.ok) {
    return { repo: input, info: null, digest: null, error: describeSearchMiss(input, found.miss) };
  }
  const digest = await fetchDigest(found.owner, found.repo);
  return { repo: `${found.owner}/${found.repo}`, info: found.info, digest };
}

interface GitHubRepoData {
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
  size: number;
}

function mapRepoData(data: GitHubRepoData): RepoInfo {
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
    sizeKb: data.size ?? 0,
  };
}

async function fetchRepoInfo(owner: string, repo: string): Promise<RepoInfo | null> {
  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { "User-Agent": "dial-a-repo", Accept: "application/vnd.github+json" },
    });
    if (!resp.ok) return null;

    const data = await resp.json<GitHubRepoData>();
    if (data.private) return null;

    return mapRepoData(data);
  } catch {
    return null;
  }
}

/**
 * Resolves a bare project name (no "/", so not "owner/repo" -- caller
 * said something like "react" or "vite" instead of the exact repo) to
 * the most popular matching public repo via GitHub's search API. Lets
 * callers mention a well-known project without knowing its GitHub
 * namespace. Picks the highest-starred result whose repo name matches
 * exactly (case-insensitive) among the top few hits, falling back to
 * the single top hit by stars if none match exactly -- good enough for
 * well-known projects ("react" -> react/react, "vite" -> vitejs/vite),
 * not guaranteed for generic or ambiguous names.
 */
// Below this star count, a search "match" isn't trustworthy enough to
// describe as if it were the repo the caller meant -- see
// SearchMiss.reason "low_confidence" below. Chosen from a real failure:
// a caller asking about "the Py coding agent" (a description, not a
// real project name) matched a 22-star repo on token overlap alone,
// which got described with the same confidence as an 85k-star exact
// match for a real request ("pi"). Exact name matches always count as
// confident regardless of stars -- a small but exactly-named repo is
// still clearly the thing the caller meant.
const MIN_STARS_FOR_FUZZY_MATCH = 500;

export interface SearchMiss {
  reason: "no_results" | "low_confidence";
  /** Best candidate found, for a "low_confidence" miss -- lets the caller ask "did you mean X?". */
  closest?: { repo: string; stars: number };
}

async function searchRepoByName(
  name: string
): Promise<{ ok: true; owner: string; repo: string; info: RepoInfo } | { ok: false; miss: SearchMiss }> {
  try {
    const query = encodeURIComponent(`${name} in:name fork:false`);
    const resp = await fetch(
      `https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=5`,
      { headers: { "User-Agent": "dial-a-repo", Accept: "application/vnd.github+json" } }
    );
    if (!resp.ok) return { ok: false, miss: { reason: "no_results" } };

    const data = await resp.json<{ items: (GitHubRepoData & { name: string; full_name: string })[] }>();
    const candidates = (data.items ?? []).filter((item) => !item.private);
    if (candidates.length === 0) return { ok: false, miss: { reason: "no_results" } };

    const exactMatch = candidates.find((item) => item.name.toLowerCase() === name.trim().toLowerCase());
    const best = exactMatch ?? candidates[0];

    if (!exactMatch && best.stargazers_count < MIN_STARS_FOR_FUZZY_MATCH) {
      return {
        ok: false,
        miss: { reason: "low_confidence", closest: { repo: best.full_name, stars: best.stargazers_count } },
      };
    }

    const [owner, repo] = best.full_name.split("/");
    if (!owner || !repo) return { ok: false, miss: { reason: "no_results" } };

    return { ok: true, owner, repo, info: mapRepoData(best) };
  } catch {
    return { ok: false, miss: { reason: "no_results" } };
  }
}

function describeSearchMiss(name: string, miss: SearchMiss): string {
  if (miss.reason === "low_confidence" && miss.closest) {
    return (
      `Could not confidently match "${name}" to a well-known public GitHub repo -- the closest ` +
      `name match was "${miss.closest.repo}" (${miss.closest.stars} stars), which isn't popular ` +
      `enough to be a confident guess. Ask the caller for the exact "owner/repo" instead, or whether ` +
      `they meant "${miss.closest.repo}".`
    );
  }
  return `Could not find a public GitHub repo matching "${name}". Ask the caller for "owner/repo" or a github.com URL instead.`;
}

/**
 * Resolves "owner/repo", a GitHub URL, or a bare project name (see
 * searchRepoByName) down to what RepoWorkspace needs to clone it: the
 * clone URL, default branch, and size (to guard against cloning
 * something huge live on a call -- see MAX_REPO_SIZE_KB in
 * repoWorkspace.ts). Used by the git-backed tools (repo_recent_commits,
 * repo_file, repo_diff), which each need a real clone rather than
 * load_repo's flat digest. Unlike loadRepoContext, metadata is required
 * here (not optional) -- there's nothing to clone without a resolved
 * default branch.
 */
export async function resolveCloneTarget(
  input: string
): Promise<{ ok: true; target: CloneTarget } | { ok: false; error: string }> {
  const parsed = parseRepoSpec(input);
  if (parsed) {
    const info = await fetchRepoInfo(parsed.owner, parsed.repo);
    if (!info) {
      return {
        ok: false,
        error: `Could not find a public GitHub repo at "${parsed.owner}/${parsed.repo}". It may not exist, may be private, or the name may be misspelled.`,
      };
    }
    return {
      ok: true,
      target: {
        repo: `${parsed.owner}/${parsed.repo}`,
        cloneUrl: `https://github.com/${parsed.owner}/${parsed.repo}.git`,
        defaultBranch: info.defaultBranch,
        sizeKb: info.sizeKb,
      },
    };
  }

  const found = await searchRepoByName(input);
  if (!found.ok) {
    return { ok: false, error: describeSearchMiss(input, found.miss) };
  }
  return {
    ok: true,
    target: {
      repo: `${found.owner}/${found.repo}`,
      cloneUrl: `https://github.com/${found.owner}/${found.repo}.git`,
      defaultBranch: found.info.defaultBranch,
      sizeKb: found.info.sizeKb,
    },
  };
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
