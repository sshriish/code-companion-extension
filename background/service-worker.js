/**
 * background/service-worker.js
 * The only place that touches secrets (GitHub PAT, Groq key). Content
 * scripts and the panel/popup UI talk to this worker exclusively via
 * chrome.runtime.sendMessage — they never call api.github.com or
 * api.groq.com directly.
 */

import {
  getFileContent,
  getLatestCommitForPath,
  parseRepoFromUrl,
  parseLineRangeFromHash,
  searchCode,
  GitHubRateLimitError
} from "../lib/github-api.js";
import { explainSnippet, summarizeLargeSnippet, getComplexityOpinion } from "../lib/groq-api.js";
import {
  getSettings,
  setSettings,
  addHistoryEntry,
  searchHistory,
  deleteHistoryEntry,
  clearHistory,
  getCachedComplexity,
  setCachedComplexity
} from "../lib/storage.js";
import { scoreComplexity, shouldSkipFile } from "../lib/complexity-heuristic.js";

const MENU_ID = "code-companion-explain";
const LARGE_SELECTION_LINE_THRESHOLD = 200;

// ---------- Context menu ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Explain this with Code Companion",
    contexts: ["selection"],
    documentUrlPatterns: ["*://github.com/*/*/blob/*"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, {
    type: "CC_OPEN_PANEL_FOR_SELECTION",
    selectionText: info.selectionText || ""
  });
});

// ---------- Message router ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => {
      console.error("[code-companion] background error:", err);
      sendResponse({
        ok: false,
        error: err.message || String(err),
        rateLimited: err instanceof GitHubRateLimitError,
        resetAt: err.resetAt
      });
    });
  return true; // keep the channel open for async sendResponse
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "CC_GET_SETTINGS":
      return { settings: await getSettings() };

    case "CC_SET_SETTINGS":
      return { settings: await setSettings(message.settings) };

    case "CC_EXPLAIN_SNIPPET":
      return explainSnippetFlow(message.payload);

    case "CC_SAVE_HISTORY":
      return { entry: await addHistoryEntry(message.entry) };

    case "CC_SEARCH_HISTORY":
      return { results: await searchHistory(message.payload || {}) };

    case "CC_DELETE_HISTORY":
      return { history: await deleteHistoryEntry(message.payload?.id) };

    case "CC_CLEAR_HISTORY":
      await clearHistory();
      return {};

    case "CC_GET_FILE_COMPLEXITY":
      return getFileComplexityFlow(message.payload);

    case "CC_GET_COMPLEXITY_OPINION":
      return getComplexityOpinionFlow(message.payload);

    case "CC_SEARCH_CODE":
      return searchCodeFlow(message.payload);

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

// ---------- Feature 1: Explain This ----------

async function explainSnippetFlow(payload) {
  const { code, filePath, url, language, wantSummary } = payload;
  const { githubToken, groqApiKey } = await getSettings();

  if (!groqApiKey) {
    throw new Error("Add your free Groq API key in the extension settings (popup) first.");
  }

  const lineCount = code.split("\n").length;
  const tooLarge = lineCount > LARGE_SELECTION_LINE_THRESHOLD;

  // Best-effort: fetch a bit of surrounding context via the GitHub API if we
  // have a token and can identify the repo/ref. Failures here are non-fatal;
  // we fall back to explaining the snippet in isolation.
  let surroundingContext;
  const repoInfo = url ? parseRepoFromUrl(url) : null;
  if (githubToken && repoInfo && !tooLarge) {
    try {
      const refMatch = url.match(/\/blob\/([^/]+)\//);
      const ref = refMatch ? refMatch[1] : undefined;
      const { content } = await getFileContent({
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        path: filePath,
        ref,
        token: githubToken
      });
      // Keep this cheap: just grab a window of ~40 lines around the snippet
      // if we can find it, otherwise skip rather than sending whole files.
      const idx = content.indexOf(code.trim().split("\n")[0]);
      if (idx !== -1) {
        const start = Math.max(0, idx - 800);
        const end = Math.min(content.length, idx + code.length + 800);
        surroundingContext = content.slice(start, end);
      }
    } catch (e) {
      console.warn("[code-companion] could not fetch surrounding context:", e.message);
    }
  }

  const result =
    tooLarge && wantSummary !== false
      ? await summarizeLargeSnippet({ apiKey: groqApiKey, code, filePath, language })
      : await explainSnippet({ apiKey: groqApiKey, code, filePath, language, surroundingContext });

  return { explanation: result, truncated: tooLarge, lineCount };
}

// ---------- Feature 2: Complexity heatmap ----------

async function getFileComplexityFlow(payload) {
  const { owner, repo, path, ref } = payload;
  const { githubToken } = await getSettings();

  if (shouldSkipFile(path)) {
    return { skipped: true };
  }

  const sha = await getLatestCommitForPath({ owner, repo, path, token: githubToken });
  const cacheKey = `${owner}/${repo}/${sha}/${path}`;

  const cached = await getCachedComplexity(cacheKey);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  const { content, size } = await getFileContent({ owner, repo, path, ref, token: githubToken });

  // Skip huge files (>500KB) to avoid pathological regex-scan cost.
  if (size > 500_000) {
    const result = { score: 0, band: "low", skipped: true, reason: "file too large" };
    await setCachedComplexity(cacheKey, result);
    return result;
  }

  const scored = scoreComplexity(content);
  await setCachedComplexity(cacheKey, scored);
  return scored;
}

async function getComplexityOpinionFlow(payload) {
  const { owner, repo, path, ref, heuristicScore } = payload;
  const { githubToken, groqApiKey } = await getSettings();
  if (!groqApiKey) {
    throw new Error("Add your free Groq API key in the extension settings first.");
  }
  const { content } = await getFileContent({ owner, repo, path, ref, token: githubToken });
  // Cap what we send for cost/latency; a few hundred lines is plenty for an opinion.
  const truncated = content.slice(0, 8000);
  return getComplexityOpinion({ apiKey: groqApiKey, filePath: path, code: truncated, heuristicScore });
}

// ---------- Feature 4: Find code by filename + line number ----------
// Free — no LLM call. Uses GitHub's own code-search endpoint to find which
// files in a repo contain a query, then fetches each match's content once
// to resolve an exact line number (search results only give byte offsets
// into a short fragment, not real line numbers).

async function searchCodeFlow(payload) {
  const { owner, repo, query, ref } = payload;
  const { githubToken } = await getSettings();

  const hits = await searchCode({ owner, repo, query, token: githubToken, perPage: 10 });

  const resolved = [];
  for (const hit of hits) {
    try {
      const { content } = await getFileContent({
        owner,
        repo,
        path: hit.path,
        ref,
        token: githubToken
      });
      const lines = content.split("\n");
      const idx = lines.findIndex((line) => line.toLowerCase().includes(query.toLowerCase()));
      const lineNumber = idx === -1 ? null : idx + 1;
      resolved.push({
        path: hit.path,
        lineNumber,
        snippet: idx === -1 ? "" : lines[idx].trim().slice(0, 200),
        url:
          lineNumber != null
            ? `https://github.com/${owner}/${repo}/blob/${ref || "HEAD"}/${hit.path}#L${lineNumber}`
            : `https://github.com/${owner}/${repo}/blob/${ref || "HEAD"}/${hit.path}`
      });
    } catch (e) {
      // A single file failing to fetch (e.g. removed since indexing,
      // binary, huge) shouldn't sink the whole search — skip it.
      console.warn("[code-companion] could not resolve line number for", hit.path, e.message);
    }
  }

  return { results: resolved };
}

export { parseLineRangeFromHash };
