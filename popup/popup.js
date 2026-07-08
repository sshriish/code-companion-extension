/**
 * popup/popup.js
 * Powers the extension's toolbar popup: the History tab (Feature 3) and a
 * lightweight Settings tab for the GitHub PAT + Groq API key (MVP
 * auth — swap for a full GitHub OAuth App later per the build notes).
 *
 * This is plain vanilla JS (no React/build step) so the popup loads
 * instantly and the whole extension stays framework-free, per the "vanilla
 * JS + Web Components" option in the tech stack.
 *
 * All reads/writes go through chrome.runtime.sendMessage to the background
 * worker — the popup never touches chrome.storage.local directly for
 * settings, so the secrets path stays single-owner. History reads use
 * storage.js indirectly in the same way for consistency, even though
 * history itself isn't sensitive.
 */

const state = {
  history: [],
  filtered: [],
  query: "",
};

// ---------- small DOM helpers ----------

function $(sel) {
  return document.querySelector(sel);
}

function el(tag, className, children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (children) {
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c == null) return;
      node.append(typeof c === "string" ? document.createTextNode(c) : c);
    });
  }
  return node;
}

function sendMessage(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ---------- Tabs ----------

function setupTabs() {
  document.querySelectorAll(".pp-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".pp-tab").forEach((t) => t.classList.remove("pp-tab--active"));
      document.querySelectorAll(".pp-tab-panel").forEach((p) => p.classList.remove("pp-tab-panel--active"));
      tab.classList.add("pp-tab--active");
      $(`#tab-${tab.dataset.tab}`).classList.add("pp-tab-panel--active");
    });
  });
}

// ---------- History tab ----------

async function loadHistory() {
  // Directly read via storage helper semantics through a dedicated message,
  // since CC_SAVE_HISTORY already exists on the background router — add a
  // symmetrical read here. Background treats "get all" as an empty search.
  const res = await sendMessage({ type: "CC_SEARCH_HISTORY", payload: {} });
  state.history = res?.ok ? res.results : [];
  applyFilter();
  renderStat();
}

function applyFilter() {
  const q = state.query.trim().toLowerCase();
  state.filtered = !q
    ? state.history
    : state.history.filter(
        (h) =>
          h.repo?.toLowerCase().includes(q) ||
          h.filePath?.toLowerCase().includes(q) ||
          h.explanation?.toLowerCase().includes(q)
      );
  renderHistoryList();
}

function renderStat() {
  const statEl = $("#pp-stat");
  const total = state.history.length;
  const repos = new Set(state.history.map((h) => h.repo)).size;
  const now = new Date();
  const thisMonth = state.history.filter((h) => {
    const d = new Date(h.timestamp);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;

  if (!total) {
    statEl.textContent = "No snippets explained yet — right-click any selected code on GitHub to start.";
    return;
  }
  statEl.textContent = `You've explained ${thisMonth} snippet${thisMonth === 1 ? "" : "s"} across ${repos} repo${repos === 1 ? "" : "s"} this month (${total} all-time).`;
}

function groupByRepo(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.repo)) groups.set(entry.repo, []);
    groups.get(entry.repo).push(entry);
  }
  return groups;
}

function renderHistoryList() {
  const container = $("#pp-history-list");
  container.innerHTML = "";

  if (!state.filtered.length) {
    container.append(
      el("div", "pp-empty", state.history.length ? "No matches for that search." : "Nothing here yet.")
    );
    return;
  }

  const groups = groupByRepo(state.filtered);
  for (const [repo, entries] of groups) {
    entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    container.append(el("div", "pp-repo-heading", repo || "unknown repo"));
    entries.forEach((entry) => container.append(renderHistoryItem(entry)));
  }
}

function renderHistoryItem(entry) {
  const item = el("div", "pp-item");
  item.dataset.id = entry.id;

  const summary = el("div", "pp-item__summary");
  summary.append(
    el("span", "pp-item__path", `${entry.filePath} (${entry.lineRange})`),
    el("span", "pp-item__time", timeAgo(entry.timestamp))
  );

  const preview = el(
    "div",
    "pp-item__preview",
    entry.explanation?.length > 140 ? entry.explanation.slice(0, 140) + "…" : entry.explanation
  );

  const detail = el("div", "pp-item__detail pp-item__detail--hidden");
  detail.append(
    el("p", null, entry.explanation),
    entry.complexity ? el("div", "pp-item__complexity", `Complexity: ${entry.complexity}`) : null,
    renderQuestionList(entry.interviewQuestions)
  );

  const actions = el("div", "pp-item__actions");
  const revisitBtn = el("button", "pp-btn pp-btn--small", "Revisit on GitHub");
  revisitBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (entry.url) chrome.tabs.create({ url: entry.url });
  });

  const deleteBtn = el("button", "pp-btn pp-btn--small pp-btn--danger", "Delete");
  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await sendMessage({ type: "CC_DELETE_HISTORY", payload: { id: entry.id } });
    await loadHistory();
  });

  actions.append(revisitBtn, deleteBtn);
  detail.append(actions);

  item.append(summary, preview, detail);
  item.addEventListener("click", () => {
    detail.classList.toggle("pp-item__detail--hidden");
  });

  return item;
}

function renderQuestionList(questions) {
  if (!questions || !questions.length) return null;
  const wrap = el("div", "pp-item__questions");
  wrap.append(el("strong", null, "Interview questions"));
  const ul = el("ul");
  questions.forEach((q) => ul.append(el("li", null, q)));
  wrap.append(ul);
  return wrap;
}

function setupSearch() {
  $("#pp-search-input").addEventListener("input", (e) => {
    state.query = e.target.value;
    applyFilter();
  });
}

function setupClearAll() {
  $("#pp-clear-all").addEventListener("click", async () => {
    if (!confirm("Clear all saved explanations? This can't be undone.")) return;
    await sendMessage({ type: "CC_CLEAR_HISTORY" });
    await loadHistory();
  });
}

// ---------- Settings tab ----------

async function loadSettings() {
  const res = await sendMessage({ type: "CC_GET_SETTINGS" });
  const settings = res?.ok ? res.settings : {};
  if (settings.githubToken) $("#pp-github-token").placeholder = "•••••••••••••••• (saved)";
  if (settings.groqApiKey) $("#pp-groq-key").placeholder = "•••••••••••••••• (saved)";
}

function setupSettingsForm() {
  $("#pp-settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const githubToken = $("#pp-github-token").value.trim();
    const groqApiKey = $("#pp-groq-key").value.trim();

    const partial = {};
    if (githubToken) partial.githubToken = githubToken;
    if (groqApiKey) partial.groqApiKey = groqApiKey;

    const res = await sendMessage({ type: "CC_SET_SETTINGS", settings: partial });
    const statusEl = $("#pp-save-status");
    statusEl.textContent = res?.ok ? "Saved ✓" : "Failed to save";
    statusEl.classList.toggle("pp-save-status--error", !res?.ok);

    // Clear the inputs so raw secrets don't linger visibly in the DOM/form
    // state after a successful save.
    if (res?.ok) {
      $("#pp-github-token").value = "";
      $("#pp-groq-key").value = "";
      await loadSettings();
    }
    setTimeout(() => (statusEl.textContent = ""), 2500);
  });
}

// ---------- Search tab (Feature 4: find code by filename + line number) ----------

async function detectCurrentRepo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    const m = tab.url.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!m) return null;
    return { owner: m[1], repo: m[2], full: `${m[1]}/${m[2]}` };
  } catch {
    return null;
  }
}

async function setupSearchTab() {
  const repoInput = $("#pp-search-repo");
  const queryInput = $("#pp-search-query");
  const statusEl = $("#pp-search-status");
  const resultsEl = $("#pp-search-results");

  const detected = await detectCurrentRepo();
  if (detected) repoInput.value = detected.full;

  async function runSearch() {
    const [owner, repo] = repoInput.value.trim().split("/");
    const query = queryInput.value.trim();
    resultsEl.innerHTML = "";

    if (!owner || !repo) {
      statusEl.textContent = "Enter a repo as owner/repo.";
      return;
    }
    if (!query) {
      statusEl.textContent = "Type something to search for.";
      return;
    }

    statusEl.textContent = "Searching…";
    const res = await sendMessage({
      type: "CC_SEARCH_CODE",
      payload: { owner, repo, query }
    });

    if (!res?.ok) {
      statusEl.textContent = res?.error || "Search failed.";
      return;
    }

    const results = res.results || [];
    statusEl.textContent = results.length
      ? `${results.length} match${results.length === 1 ? "" : "es"}`
      : "No matches found.";

    results.forEach((r) => resultsEl.append(renderSearchResult(r)));
  }

  $("#pp-search-btn").addEventListener("click", runSearch);
  queryInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });
}

function renderSearchResult(result) {
  const item = el("div", "pp-item");
  const summary = el("div", "pp-item__summary");
  const lineLabel =
    result.lineNumber && result.endLineNumber && result.endLineNumber !== result.lineNumber
      ? `L${result.lineNumber}-L${result.endLineNumber}`
      : result.lineNumber
      ? `L${result.lineNumber}`
      : null;
  summary.append(
    el("span", "pp-item__path", lineLabel ? `${result.path} (${lineLabel})` : result.path)
  );
  const preview = el("div", "pp-item__preview", result.snippet || "(match found, exact line not shown)");
  const actions = el("div", "pp-item__actions");
  const openBtn = el("button", "pp-btn pp-btn--small", "Open on GitHub");
  openBtn.addEventListener("click", () => chrome.tabs.create({ url: result.url }));
  actions.append(openBtn);
  item.append(summary, preview, actions);
  return item;
}

// ---------- init ----------

document.addEventListener("DOMContentLoaded", async () => {
  setupTabs();
  setupSearch();
  setupClearAll();
  setupSettingsForm();
  await Promise.all([loadHistory(), loadSettings(), setupSearchTab()]);
});
