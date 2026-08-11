import { DurableObject } from "cloudflare:workers";
import { type DurableObjectStorageLike, getWorkspace, withWorkspace } from "@cloudflare/computer";
import { type CommitView, type GitClient, createGitClient } from "@cloudflare/computer/git";

// The real protection against OOM-ing the ~128 MB isolate mid-call. This
// is GitHub's `size` field (the repo's full on-disk size including
// history); it correlates loosely with clone memory, so the threshold is
// deliberately conservative. Calibrated from real calls: cloudflare/computer
// (~3.9 MB) clones and serves git history fine; earendil-works/pi (~60 MB)
// OOM'd even at depth 20 with no working-tree checkout (see CLONE_DEPTH).
// 30 MB sits well above the former and well below the latter -- a coarse
// line (no data points in between) that gets a big repo the friendly
// decline below instead of crashing the call. Over this, load_repo's flat
// digest still works, just not real git history/file access.
const MAX_REPO_SIZE_KB = 30_000; // ~30 MB

// Shallow clone depth. Kept small as basic hygiene, but note it is NOT
// what prevents OOM: a live call proved earendil-works/pi still OOM'd at
// depth 20, because per @cloudflare/computer's GitCloneOptions docs even
// depth 1 fetches every blob reachable from the tip tree, and isomorphic-git
// indexes that whole pack in memory. Depth only trims *historical*
// versions -- enough for "what changed recently" on the small repos the
// size guard above actually lets through.
const CLONE_DEPTH = 20;

// Re-clone/pull isn't worth doing on every call for a repo this DO has
// already cloned -- only refresh if the last sync is older than this.
const REFRESH_AFTER_MS = 15 * 60 * 1000;

// Log entries beyond this are just noise for a spoken conversation.
const MAX_LOG_RESULTS = 20;
// How far back to walk when the caller asks for a time window (e.g. "in
// the last month") rather than a fixed count -- isomorphic-git's log
// doesn't support --since, so this is filtered client-side. Bounded by
// CLONE_DEPTH: the shallow clone simply has no commits deeper than that,
// so a time window can't see further back than the clone reaches.
const LOG_DEPTH_FOR_TIME_WINDOW = CLONE_DEPTH;

const MAX_FILE_CHARS = 20_000;
const MAX_DIFF_CHARS = 8_000;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[...truncated for length...]` : text;
}

// git.catFile's filepath is repo-relative with no leading slash.
function normalizeRepoPath(path: string): string {
  return path.replace(/^\/+/, "");
}

// @cloudflare/computer's own WorkspaceClient.git is typed `any` --
// deliberate, per its docs, to keep the package's default dependency
// graph free of git unless a caller opts in via createGitClient(). Cast
// once to the real GitClient shape (from the git subpath) instead of
// letting `any` leak into every call site below.
function typedGit(ws: { git: unknown }): GitClient {
  return ws.git as GitClient;
}

export interface CommitSummary {
  oid: string;
  message: string;
  author: string;
  date: string;
}

/**
 * A real, cloned working copy of one GitHub repo's git history, backed by
 * @cloudflare/computer's SQLite-backed Workspace filesystem and its
 * isomorphic-git-based git client -- no shell, no container, no Worker
 * Loader. Keyed by repo slug (see callSession.ts), not by call -- once a
 * repo is cloned, every future call about it (from anyone) reuses the
 * same clone instead of re-cloning from scratch.
 *
 * @cloudflare/computer is explicitly a preview package ("NOT suitable for
 * production use at this time" per its own README) -- using it here is a
 * deliberate stress test, not an oversight. File issues upstream if
 * something breaks.
 */
export class RepoWorkspace extends withWorkspace(
  class extends DurableObject<Env> {},
  (self) => {
    const { ctx } = self as unknown as { ctx: DurableObjectState };
    return {
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      git: createGitClient(),
      defaultGitIdentity: { name: "Dial-a-Repo", email: "dial-a-repo@ziki.workers.dev" },
    };
  }
) {
  /**
   * Clones the repo on first use; on later calls, refreshes it with a
   * fast-forward pull if the last sync is stale. Every other RPC method
   * below assumes this has already succeeded.
   */
  async ensureCloned(
    cloneUrl: string,
    defaultBranch: string,
    sizeKb: number
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (sizeKb > MAX_REPO_SIZE_KB) {
      return {
        ok: false,
        error:
          `This repo is about ${Math.round(sizeKb / 1024)} MB, too large to clone live on a call ` +
          `(limit ~${Math.round(MAX_REPO_SIZE_KB / 1024)} MB). Structure and README info from load_repo ` +
          "is still available, just not git history or full file contents.",
      };
    }

    using ws = await getWorkspace(this);

    const alreadyCloned = await this.hasClone(ws);
    if (!alreadyCloned) {
      try {
        // paths: [] skips materializing the working tree in the VFS --
        // .git/ is still fully populated, and every read op below
        // (log, catFile by oid, diff by ref) works from the object
        // database, not a checked-out tree. Saves memory and storage.
        await typedGit(ws).clone({
          url: cloneUrl,
          ref: defaultBranch,
          depth: CLONE_DEPTH,
          singleBranch: true,
          paths: [],
        });
      } catch (err) {
        return { ok: false, error: `Could not clone this repo: ${String(err)}` };
      }
      await this.ctx.storage.put("lastSyncedAt", Date.now());
      return { ok: true };
    }

    const lastSyncedAt = (await this.ctx.storage.get<number>("lastSyncedAt")) ?? 0;
    if (Date.now() - lastSyncedAt > REFRESH_AFTER_MS) {
      try {
        await typedGit(ws).pull({ fastForwardOnly: true });
      } catch (err) {
        // Best-effort refresh -- keep serving the existing clone rather
        // than failing the whole call over a stale-but-usable repo.
        console.error(JSON.stringify({ msg: "repo_refresh_failed", cloneUrl, error: String(err) }));
      }
      await this.ctx.storage.put("lastSyncedAt", Date.now());
    }

    return { ok: true };
  }

  /**
   * Recent commit history. Pass `sinceDays` for "what's changed in the
   * last month" style questions, or `limit` for "what were the last N
   * commits" -- isomorphic-git's log has no --since, so a time window is
   * done by walking deeper and filtering client-side on commit timestamp.
   */
  async recentCommits(
    limit: number,
    sinceDays?: number
  ): Promise<{ commits: CommitSummary[] } | { error: string }> {
    using ws = await getWorkspace(this);
    try {
      const depth = sinceDays ? LOG_DEPTH_FOR_TIME_WINDOW : Math.min(Math.max(limit, 1), MAX_LOG_RESULTS);
      const commits: CommitView[] = await typedGit(ws).log({ depth });

      const cutoffSeconds = sinceDays ? Date.now() / 1000 - sinceDays * 86_400 : null;
      const selected =
        cutoffSeconds !== null ? commits.filter((c: CommitView) => c.author.timestamp >= cutoffSeconds) : commits;

      return {
        // Full oid, not an abbreviated prefix -- @cloudflare/computer's
        // git.revParse doesn't currently resolve short oid prefixes
        // despite its own docs describing that as supported. Filed:
        // https://github.com/cloudflare/computer/issues/89. A truncated
        // oid here would silently fail if the model reused it as
        // `ref`/`from` on repo_file or repo_diff.
        commits: selected.slice(0, MAX_LOG_RESULTS).map((c: CommitView) => ({
          oid: c.oid,
          message: c.message.split("\n")[0],
          author: c.author.name,
          date: new Date(c.author.timestamp * 1000).toISOString().slice(0, 10),
        })),
      };
    } catch (err) {
      return { error: String(err) };
    }
  }

  /** Full content of one file, at HEAD by default or at a given ref/commit. */
  async fileAt(path: string, ref = "HEAD"): Promise<{ content: string } | { error: string }> {
    using ws = await getWorkspace(this);
    try {
      const git = typedGit(ws);
      const oid = await git.revParse({ ref });
      const { bytes } = await git.catFile({ oid, filepath: normalizeRepoPath(path) });
      return { content: truncate(new TextDecoder().decode(bytes), MAX_FILE_CHARS) };
    } catch (err) {
      return { error: `Could not read "${path}" at ${ref}: ${String(err)}` };
    }
  }

  /** Unified diff between two refs, e.g. "HEAD~1" -> "HEAD" for the last commit. */
  async diffRefs(from: string, to = "HEAD", path?: string): Promise<{ diff: string } | { error: string }> {
    using ws = await getWorkspace(this);
    try {
      const diff = await typedGit(ws).diff({ ref: from, to, paths: path ? [normalizeRepoPath(path)] : undefined });
      return { diff: diff ? truncate(diff, MAX_DIFF_CHARS) : "(no differences)" };
    } catch (err) {
      return { error: `Could not diff ${from}..${to}: ${String(err)}` };
    }
  }

  private async hasClone(ws: Awaited<ReturnType<typeof getWorkspace>>): Promise<boolean> {
    try {
      await typedGit(ws).revParse({ ref: "HEAD" });
      return true;
    } catch {
      return false;
    }
  }
}
