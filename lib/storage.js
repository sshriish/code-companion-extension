/**
 * lib/storage.js
 * Thin wrapper around chrome.storage.local for:
 *  - settings (GitHub PAT, Anthropic key, preferences)
 *  - history log (explained snippets)
 *  - complexity cache (per repo/commit/file)
 *
 * IMPORTANT: never call chrome.storage from a content script directly for
 * secrets. Content scripts should message the background worker, which is
 * the only place that reads SETTINGS_KEY.
 */

const KEYS = {
  SETTINGS: "cc_settings",
  HISTORY: "cc_history",
  COMPLEXITY_CACHE: "cc_complexity_cache"
};

// ---------- Settings ----------

/** @returns {Promise<{githubToken?: string, anthropicKey?: string, theme?: string}>} */
export async function getSettings() {
  const { [KEYS.SETTINGS]: settings } = await chrome.storage.local.get(KEYS.SETTINGS);
  return settings || {};
}

export async function setSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ [KEYS.SETTINGS]: next });
  return next;
}

// ---------- History ----------

/** @returns {Promise<Array>} full history array, most recent first */
export async function getHistory() {
  const { [KEYS.HISTORY]: history } = await chrome.storage.local.get(KEYS.HISTORY);
  return history || [];
}

/**
 * @param {object} record - see README for shape
 */
export async function addHistoryEntry(record) {
  const history = await getHistory();
  const entry = {
    id: record.id || crypto.randomUUID(),
    timestamp: record.timestamp || new Date().toISOString(),
    ...record
  };
  history.unshift(entry);

  // Guard against unbounded growth - keep the most recent 2000 entries.
  const trimmed = history.slice(0, 2000);
  await chrome.storage.local.set({ [KEYS.HISTORY]: trimmed });
  return entry;
}

export async function deleteHistoryEntry(id) {
  const history = await getHistory();
  const next = history.filter((h) => h.id !== id);
  await chrome.storage.local.set({ [KEYS.HISTORY]: next });
  return next;
}

export async function clearHistory() {
  await chrome.storage.local.set({ [KEYS.HISTORY]: [] });
}

export async function searchHistory({ repo, query } = {}) {
  const history = await getHistory();
  return history.filter((h) => {
    const matchesRepo = !repo || h.repo === repo;
    const matchesQuery =
      !query ||
      h.filePath?.toLowerCase().includes(query.toLowerCase()) ||
      h.explanation?.toLowerCase().includes(query.toLowerCase()) ||
      h.repo?.toLowerCase().includes(query.toLowerCase());
    return matchesRepo && matchesQuery;
  });
}

// ---------- Complexity cache ----------
// Keyed as `${owner}/${repo}/${sha}/${filepath}` -> { score, band, computedAt }

export async function getComplexityCache() {
  const { [KEYS.COMPLEXITY_CACHE]: cache } = await chrome.storage.local.get(
    KEYS.COMPLEXITY_CACHE
  );
  return cache || {};
}

export async function getCachedComplexity(cacheKey) {
  const cache = await getComplexityCache();
  return cache[cacheKey] || null;
}

export async function setCachedComplexity(cacheKey, value) {
  const cache = await getComplexityCache();
  cache[cacheKey] = { ...value, computedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [KEYS.COMPLEXITY_CACHE]: cache });
}

/**
 * Prune cache entries whose key's sha no longer matches a set of "live" shas
 * per path, to stop unbounded growth across many commits.
 * Simple approach: cap total cache entries at 5000, evicting oldest first.
 */
export async function pruneComplexityCache(maxEntries = 5000) {
  const cache = await getComplexityCache();
  const entries = Object.entries(cache);
  if (entries.length <= maxEntries) return;
  entries.sort((a, b) => new Date(a[1].computedAt) - new Date(b[1].computedAt));
  const toKeep = entries.slice(entries.length - maxEntries);
  await chrome.storage.local.set({ [KEYS.COMPLEXITY_CACHE]: Object.fromEntries(toKeep) });
}

export const STORAGE_KEYS = KEYS;
