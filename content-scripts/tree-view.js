/**
 * content-scripts/tree-view.js
 * Runs on github.com/{owner}/{repo} (root) and .../tree/* pages.
 *
 * Renders a complexity heatmap over the file-tree table: a colored left
 * border per file row + a numeric badge on hover, computed from a fast
 * client-side cyclomatic-complexity heuristic (see lib/complexity-heuristic.js
 * — logic is duplicated here in small part since content scripts can't
 * `import` from lib/ without a bundler).
 *
 * Performance notes:
 *  - Only rows currently in the viewport are scored (IntersectionObserver),
 *    so huge repos (1000+ files) don't all get fetched/scored at once.
 *  - Real work (fetch + score) happens in the background worker via
 *    CC_GET_FILE_COMPLEXITY, which also handles GitHub API caching/rate
 *    limits and the chrome.storage.local cache.
 *  - GitHub is a Turbo/PJAX SPA, so we re-run setup on turbo:load /
 *    soft-navigation as well as initial load.
 */

(function () {
  const LEGEND_ID = "cc-heatmap-legend";
  let observer = null;
  let currentRepoInfo = null;

  function getRepoInfoFromUrl() {
    // Matches /{owner}/{repo} or /{owner}/{repo}/tree/{ref}/{path...}
    const m = window.location.pathname.match(/^\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(\/.*)?)?/);
    if (!m) return null;
    const [, owner, repo, ref, subpath] = m;
    // Bail out on GitHub's own non-repo top-level routes.
    const reserved = new Set([
      "settings", "notifications", "issues", "pulls", "marketplace",
      "explore", "topics", "trending", "collections", "sponsors", "codespaces"
    ]);
    if (reserved.has(owner)) return null;
    return {
      owner,
      repo,
      ref: ref || "HEAD",
      subpath: subpath ? subpath.replace(/^\//, "") : ""
    };
  }

  /**
   * GitHub's repo file-tree table markup has shifted over the years
   * (react-code-view web components vs. classic `.js-navigation-item`
   * rows). We try a couple of known selectors and fall back gracefully.
   */
  function findFileRows() {
    const candidates = [
      ...document.querySelectorAll('div[role="row"][id^="folder-row-"]'),
      ...document.querySelectorAll("tr.react-directory-row"),
      ...document.querySelectorAll(".js-navigation-item")
    ];
    // De-dupe while preserving order.
    return Array.from(new Set(candidates));
  }

  function getRowFileInfo(row) {
    const link = row.querySelector('a[href*="/blob/"], a[href*="/tree/"]');
    if (!link) return null;
    const href = link.getAttribute("href") || "";
    const isDir = href.includes("/tree/");
    const nameMatch = href.match(/\/(?:blob|tree)\/[^/]+\/(.+)/);
    const path = nameMatch ? decodeURIComponent(nameMatch[1]) : link.textContent.trim();
    return { path, isDir, row };
  }

  function ensureLegend(container) {
    if (document.getElementById(LEGEND_ID)) return;
    const legend = document.createElement("div");
    legend.id = LEGEND_ID;
    legend.className = "cc-heatmap-legend";
    legend.innerHTML = `
      <span>Complexity:</span>
      <span>🟩 Low</span>
      <span>🟨 Medium</span>
      <span>🟥 High</span>
    `;
    container.insertAdjacentElement("beforebegin", legend);
  }

  function applyRowStyle(row, result) {
    row.classList.add("cc-heatmap-row");
    if (result.skipped) return;

    const colors = { low: "#2da44e", medium: "#d4a72c", high: "#cf222e" };
    row.style.borderLeftColor = colors[result.band] || "transparent";

    // Avoid stacking duplicate badges on repeated calls (e.g. cache hits
    // after re-observing).
    if (row.querySelector(".cc-heatmap-badge")) return;

    const nameCell = row.querySelector('a[href*="/blob/"]');
    if (!nameCell) return;

    const badge = document.createElement("span");
    badge.className = "cc-heatmap-badge";
    badge.textContent = `${bandEmoji(result.band)} ${result.score}`;
    badge.title = `Complexity score: ${result.score} (${result.band})`;
    nameCell.parentElement.appendChild(badge);
  }

  function bandEmoji(band) {
    return { low: "🟩", medium: "🟨", high: "🟥" }[band] || "⬜";
  }

  function markPending(row) {
    if (row.querySelector(".cc-heatmap-pending") || row.querySelector(".cc-heatmap-badge")) return;
    const nameCell = row.querySelector('a[href*="/blob/"]');
    if (!nameCell) return;
    const pending = document.createElement("span");
    pending.className = "cc-heatmap-pending";
    pending.textContent = "…";
    nameCell.parentElement.appendChild(pending);
  }

  function clearPending(row) {
    row.querySelector(".cc-heatmap-pending")?.remove();
  }

  // Simple client-side request queue with backoff so a burst of visible rows
  // doesn't hammer the background worker (and, transitively, GitHub's API)
  // all at once. Also respects a "still calculating..." UX rather than
  // silently failing when we get rate limited.
  const queue = [];
  let draining = false;
  let backoffUntil = 0;

  function enqueue(row, fileInfo) {
    queue.push({ row, fileInfo });
    drainQueue();
  }

  async function drainQueue() {
    if (draining) return;
    draining = true;
    while (queue.length) {
      if (Date.now() < backoffUntil) {
        await sleep(backoffUntil - Date.now());
      }
      const { row, fileInfo } = queue.shift();
      if (!row.isConnected) continue; // scrolled out / page navigated away
      markPending(row);
      try {
        const response = await sendMessage({
          type: "CC_GET_FILE_COMPLEXITY",
          payload: {
            owner: currentRepoInfo.owner,
            repo: currentRepoInfo.repo,
            path: fileInfo.path,
            ref: currentRepoInfo.ref
          }
        });
        clearPending(row);
        if (response?.ok) {
          applyRowStyle(row, response);
        } else if (response?.rateLimited) {
          backoffUntil = Date.now() + 30_000;
          markPending(row);
        }
      } catch (e) {
        clearPending(row);
        console.warn("[code-companion] complexity fetch failed:", e);
      }
      // Small delay between requests to stay well under GitHub's rate limit
      // even on very large trees, and to keep the UI feeling calm.
      await sleep(120);
    }
    draining = false;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, resolve);
    });
  }

  function setupObserver(container) {
    if (observer) observer.disconnect();

    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const row = entry.target;
          observer.unobserve(row);
          const info = getRowFileInfo(row);
          if (!info || info.isDir) continue;
          enqueue(row, info);
        }
      },
      { root: null, rootMargin: "200px", threshold: 0.1 }
    );

    findFileRows().forEach((row) => observer.observe(row));
  }

  function init() {
    const repoInfo = getRepoInfoFromUrl();
    if (!repoInfo) return;
    currentRepoInfo = repoInfo;

    const rows = findFileRows();
    if (!rows.length) return;

    const container = rows[0].closest("table, div[role='grid'], div[role='table']") || rows[0].parentElement;
    if (container) ensureLegend(container);

    setupObserver(container);
  }

  // Initial load.
  init();

  // GitHub navigates between tree pages via Turbo without a full reload —
  // re-run setup after each soft navigation. `turbo:load` covers most cases;
  // a MutationObserver fallback catches anything Turbo doesn't fire for.
  document.addEventListener("turbo:load", init);
  document.addEventListener("turbo:render", init);

  let lastPath = window.location.pathname;
  const navWatcher = new MutationObserver(() => {
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname;
      // Give GitHub's own render a moment to finish painting the new tree.
      setTimeout(init, 300);
    }
  });
  navWatcher.observe(document.body, { childList: true, subtree: true });
})();
