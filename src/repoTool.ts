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

export async function loadRepoContext(input: string, apiKey?: string): Promise<RepoContext> {
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
  const found = await resolveRepoByName(input, apiKey);
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

type SearchCandidate = GitHubRepoData & { name: string; full_name: string };

type ResolveResult =
  | { ok: true; owner: string; repo: string; info: RepoInfo }
  | { ok: false; miss: SearchMiss };

/** GitHub search API results for a bare name, highest-starred first, private repos dropped. */
async function githubSearchCandidates(name: string): Promise<SearchCandidate[]> {
  try {
    const query = encodeURIComponent(`${name} in:name fork:false`);
    const resp = await fetch(
      `https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=5`,
      { headers: { "User-Agent": "dial-a-repo", Accept: "application/vnd.github+json" } }
    );
    if (!resp.ok) return [];
    const data = await resp.json<{ items: SearchCandidate[] }>();
    return (data.items ?? []).filter((item) => !item.private);
  } catch {
    return [];
  }
}

function candidateResult(candidate: SearchCandidate): ResolveResult {
  const [owner, repo] = candidate.full_name.split("/");
  if (!owner || !repo) return { ok: false, miss: { reason: "no_results" } };
  return { ok: true, owner, repo, info: mapRepoData(candidate) };
}

/**
 * Resolves a bare project name (no "/", so not "owner/repo" -- caller
 * said something like "react", "vite", or a short description like "the
 * pi coding agent") to the best matching public repo. Runs two lookups
 * in parallel and combines them:
 *
 *  - GitHub's search API (fast, free, but weak on descriptions -- it
 *    only matches on the repo's own name, so a plausible-sounding but
 *    wrong low-star repo often outranks the real, well-known project).
 *  - A github.com-scoped web search via xAI (see webSearchRepo), which
 *    is much better at turning a fuzzy description into the actual repo
 *    people mean, at the cost of a slower, paid model call.
 *
 * Priority: an exact GitHub name match wins outright (a caller who says
 * "react" clearly means react/react -- free and unambiguous). Otherwise
 * a verified web-search result wins over GitHub's non-exact guesses,
 * since that's exactly the case GitHub search gets wrong. Falls back to
 * GitHub's top hit only if it clears the confidence bar, else reports a
 * miss. Web search is skipped entirely when no apiKey is supplied.
 */
async function resolveRepoByName(name: string, apiKey?: string): Promise<ResolveResult> {
  const [candidates, webCandidate] = await Promise.all([
    githubSearchCandidates(name),
    apiKey ? webSearchRepo(name, apiKey) : Promise.resolve(null),
  ]);

  const exactMatch = candidates.find((item) => item.name.toLowerCase() === name.trim().toLowerCase());
  if (exactMatch) return candidateResult(exactMatch);

  // Trust the web-search result over GitHub's non-exact guesses, but
  // only after confirming the repo actually exists (and to get its
  // metadata) -- a web search can name a repo that's moved or wrong.
  if (webCandidate) {
    const info = await fetchRepoInfo(webCandidate.owner, webCandidate.repo);
    if (info) return { ok: true, owner: webCandidate.owner, repo: webCandidate.repo, info };
  }

  const best = candidates[0];
  if (best && best.stargazers_count >= MIN_STARS_FOR_FUZZY_MATCH) return candidateResult(best);

  if (best) {
    return {
      ok: false,
      miss: { reason: "low_confidence", closest: { repo: best.full_name, stars: best.stargazers_count } },
    };
  }
  return { ok: false, miss: { reason: "no_results" } };
}

// xAI model used for the github.com-scoped web search resolver. A
// reasoning model with the web_search tool is slow (several seconds) but
// far more accurate than GitHub search for fuzzy descriptions -- an
// accepted latency tradeoff, since this only runs as a fallback for bare
// names GitHub couldn't match exactly. Swap for a cheaper/faster model
// if it proves good enough. The timeout keeps a slow or hanging search
// from stalling the whole tool call -- on timeout we just fall back to
// GitHub's result.
const WEB_SEARCH_MODEL = "grok-4.5";
const WEB_SEARCH_TIMEOUT_MS = 12_000;

interface XaiResponse {
  output_text?: string;
  output?: { content?: { type?: string; text?: string }[] }[];
}

/** Pulls the model's final text out of an xAI /v1/responses payload. */
function extractResponseText(data: XaiResponse): string {
  if (typeof data.output_text === "string") return data.output_text.trim();
  const parts: string[] = [];
  for (const item of data.output ?? []) {
    for (const chunk of item.content ?? []) {
      if (chunk.type === "output_text" && typeof chunk.text === "string") parts.push(chunk.text);
    }
  }
  return parts.join("").trim();
}

/**
 * Asks xAI's web_search tool (scoped to github.com) to turn a bare name
 * or short description into a single "owner/repo". Returns null on any
 * failure, timeout, or when the model can't find a confident match --
 * the caller falls back to GitHub search in all those cases. The result
 * is NOT trusted until the caller verifies it exists via the GitHub API.
 */
async function webSearchRepo(name: string, apiKey: string): Promise<{ owner: string; repo: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS);
  try {
    const prompt =
      `A caller to a voice assistant wants to identify a public GitHub repository from this ` +
      `name or description: "${name}". Find the single best-matching public repository on ` +
      `github.com. Respond with ONLY the repository as "owner/repo" and nothing else. If you ` +
      `cannot find a confident match, respond with exactly: NONE`;
    const resp = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: WEB_SEARCH_MODEL,
        input: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search", filters: { allowed_domains: ["github.com"] } }],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return null;

    const text = extractResponseText(await resp.json<XaiResponse>());
    if (!text || /^none\b/i.test(text)) return null;

    // The model was told to answer with just "owner/repo", but be lenient:
    // pull the first owner/repo (or github.com/owner/repo) token out of
    // whatever it returned.
    const match = text.replace(/[`*]/g, "").match(/(?:github\.com\/)?([\w.-]+)\/([\w.-]+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
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
 * resolveRepoByName) down to what RepoWorkspace needs to clone it: the
 * clone URL, default branch, and size (to guard against cloning
 * something huge live on a call -- see MAX_REPO_SIZE_KB in
 * repoWorkspace.ts). Used by the git-backed tools (repo_recent_commits,
 * repo_file, repo_diff), which each need a real clone rather than
 * load_repo's flat digest. Unlike loadRepoContext, metadata is required
 * here (not optional) -- there's nothing to clone without a resolved
 * default branch.
 */
export async function resolveCloneTarget(
  input: string,
  apiKey?: string
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

  const found = await resolveRepoByName(input, apiKey);
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
