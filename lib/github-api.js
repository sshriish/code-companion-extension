/**
 * lib/github-api.js
 * Wrapper around the GitHub REST API v3. This module is imported by the
 * background service worker only — it needs the user's PAT, which content
 * scripts never see directly.
 */

const API_ROOT = "https://api.github.com";

class GitHubRateLimitError extends Error {
  constructor(resetAt) {
    super(`GitHub API rate limit exceeded. Resets at ${resetAt}`);
    this.name = "GitHubRateLimitError";
    this.resetAt = resetAt;
  }
}

function buildHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Central fetch wrapper: surfaces rate-limit info so callers can back off.
 * @returns {Promise<{data: any, rateLimit: {remaining: number, reset: number}}>}
 */
async function ghFetch(path, { token, params } = {}) {
  const url = new URL(`${API_ROOT}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });
  }

  const res = await fetch(url.toString(), { headers: buildHeaders(token) });

  const remaining = Number(res.headers.get("x-ratelimit-remaining"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));

  if (res.status === 403 && remaining === 0) {
    throw new GitHubRateLimitError(new Date(reset * 1000).toISOString());
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  return { data, rateLimit: { remaining, reset } };
}

/** Parse "owner/repo" style identifiers out of a github.com URL. */
export function parseRepoFromUrl(url) {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/** Parse a `#L45-L52` (or single `#L45`) anchor into a {start, end} range. */
export function parseLineRangeFromHash(hash) {
  const m = hash.match(/#?L(\d+)(?:-L(\d+))?/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : start;
  return { start, end };
}

/**
 * Fetch raw file content (decoded from base64) for a given path at a ref.
 */
export async function getFileContent({ owner, repo, path, ref, token }) {
  const { data } = await ghFetch(`/repos/${owner}/${repo}/contents/${path}`, {
    token,
    params: { ref }
  });
  if (Array.isArray(data)) {
    throw new Error(`${path} is a directory, not a file`);
  }
  if (data.encoding === "base64") {
    const binary = atob(data.content.replace(/\n/g, ""));
    // decode UTF-8 safely
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return { content: new TextDecoder("utf-8").decode(bytes), sha: data.sha, size: data.size };
  }
  return { content: data.content, sha: data.sha, size: data.size };
}

/**
 * Fetch the full recursive file tree for a repo at a ref (default branch if
 * ref omitted). Use `recursive: 1` sparingly on huge repos.
 */
export async function getTree({ owner, repo, sha = "HEAD", recursive = false, token }) {
  const { data } = await ghFetch(`/repos/${owner}/${repo}/git/trees/${sha}`, {
    token,
    params: recursive ? { recursive: 1 } : undefined
  });
  return data.tree; // [{path, mode, type, sha, size, url}]
}

/**
 * Get the latest commit SHA that touched a given path — used as the cache
 * invalidation key for the complexity heatmap.
 */
export async function getLatestCommitForPath({ owner, repo, path, token }) {
  const { data } = await ghFetch(`/repos/${owner}/${repo}/commits`, {
    token,
    params: { path, per_page: 1 }
  });
  return data[0]?.sha || null;
}

export { GitHubRateLimitError };
