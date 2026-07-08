/**
 * content-scripts/commit-view.js
 * Runs on github.com/{owner}/{repo}/commit/{sha} pages.
 *
 * Adds a floating "Explain this commit" button. On click, the background
 * worker fetches the commit's diff (via GitHub's `.diff` endpoint) and asks
 * Groq for a plain-English summary, likely motivation, and risk areas, then
 * this script renders that into the same slide-in panel used by
 * "Explain This" on blob pages.
 *
 * NOTE: content scripts declared in manifest.json can't use ES `import`, so
 * this file is intentionally self-contained (small duplication with
 * file-view.js is preferred here over a bundler — see that file's header).
 */

(function () {
  const PANEL_ID = "code-companion-panel";
  const FAB_ID = "cc-commit-fab-btn";

  function getCommitInfoFromUrl() {
    const m = window.location.pathname.match(/^\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]+)/i);
    if (!m) return null;
    return { owner: m[1], repo: m[2], sha: m[3] };
  }

  /**
   * GitHub's commit-page markup shifts over time; try a couple of known
   * selectors for the full commit message first, then fall back to the
   * page <title> (format: "{message} · {owner}/{repo}@{sha}"), which has
   * stayed stable far longer than any single CSS selector.
   */
  function getCommitMessage() {
    const titleEl = document.querySelector(".commit-title, [data-testid='commit-title']");
    const descEl = document.querySelector(".commit-desc, [data-testid='commit-description']");
    if (titleEl) {
      const title = titleEl.textContent.trim();
      const desc = descEl ? descEl.textContent.trim() : "";
      return desc ? `${title}\n\n${desc}` : title;
    }
    const fromDocTitle = document.title.split(" · ")[0]?.trim();
    return fromDocTitle || "(commit message unavailable)";
  }

  function ensureFab() {
    if (document.getElementById(FAB_ID)) return;
    const btn = document.createElement("button");
    btn.id = FAB_ID;
    btn.className = "cc-commit-fab";
    btn.textContent = "✨ Explain this commit";
    btn.addEventListener("click", handleExplainCommit);
    document.body.appendChild(btn);
  }

  function ensurePanelRoot() {
    let root = document.getElementById(PANEL_ID);
    if (root) return root;
    root = document.createElement("div");
    root.id = PANEL_ID;
    root.className = "cc-panel cc-panel--hidden";
    root.setAttribute(
      "data-theme",
      document.documentElement.getAttribute("data-code-companion-theme") || "light"
    );
    document.body.appendChild(root);
    return root;
  }

  function renderSkeleton(root, meta) {
    root.innerHTML = `
      <div class="cc-panel__header">
        <div class="cc-panel__title">
          <span class="cc-panel__logo">✨</span>
          <span>Code Companion</span>
        </div>
        <button class="cc-panel__close" aria-label="Close">×</button>
      </div>
      <div class="cc-panel__meta">
        <div class="cc-panel__file">${escapeHtml(meta.repo)}</div>
        <div class="cc-panel__lines">${meta.shortSha}</div>
      </div>
      <div class="cc-panel__body">
        <div class="cc-skeleton"></div>
        <div class="cc-skeleton"></div>
        <div class="cc-skeleton cc-skeleton--short"></div>
        <div class="cc-panel__loading-text">Reading the diff…</div>
      </div>
    `;
    root.querySelector(".cc-panel__close").addEventListener("click", () => hidePanel(root));
  }

  function renderError(root, meta, message) {
    root.innerHTML = `
      <div class="cc-panel__header">
        <div class="cc-panel__title">
          <span class="cc-panel__logo">✨</span>
          <span>Code Companion</span>
        </div>
        <button class="cc-panel__close" aria-label="Close">×</button>
      </div>
      <div class="cc-panel__meta">
        <div class="cc-panel__file">${escapeHtml(meta.repo)}</div>
        <div class="cc-panel__lines">${meta.shortSha}</div>
      </div>
      <div class="cc-panel__body">
        <div class="cc-panel__error">
          <strong>Couldn't explain this commit.</strong>
          <p>${escapeHtml(message)}</p>
        </div>
      </div>
    `;
    root.querySelector(".cc-panel__close").addEventListener("click", () => hidePanel(root));
  }

  function renderCommitExplanation(root, meta, result) {
    const { explanation, filesChanged, truncated } = result;
    const risks = explanation.riskAreas || [];
    const fileCountLabel = `${filesChanged} file${filesChanged === 1 ? "" : "s"} changed`;

    root.innerHTML = `
      <div class="cc-panel__header">
        <div class="cc-panel__title">
          <span class="cc-panel__logo">✨</span>
          <span>Code Companion</span>
        </div>
        <button class="cc-panel__close" aria-label="Close">×</button>
      </div>
      <div class="cc-panel__meta">
        <div class="cc-panel__file">${escapeHtml(meta.repo)}</div>
        <div class="cc-panel__lines">${meta.shortSha}</div>
      </div>
      <div class="cc-panel__body">
        ${
          truncated
            ? `<div class="cc-panel__warning">Diff was large — this summary is based on the first part of it (${fileCountLabel} in total).</div>`
            : `<div class="cc-panel__justification" style="margin-bottom: 16px;">${fileCountLabel}</div>`
        }

        <section class="cc-section">
          <h3>Summary</h3>
          <p>${escapeHtml(explanation.summary)}</p>
        </section>

        <section class="cc-section">
          <h3>Likely motivation</h3>
          <p>${escapeHtml(explanation.motivation || "Not clear from the diff alone.")}</p>
        </section>

        ${
          risks.length
            ? `
        <section class="cc-section cc-section--fragile">
          <h3>⚠️ Worth double-checking</h3>
          <ul class="cc-list">
            ${risks.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ul>
        </section>`
            : ""
        }
      </div>
      <div class="cc-panel__footer">
        <button class="cc-btn cc-btn--primary" id="cc-save-btn">Save to history</button>
        <button class="cc-btn" id="cc-copy-btn">Copy summary</button>
      </div>
    `;

    root.querySelector(".cc-panel__close").addEventListener("click", () => hidePanel(root));

    root.querySelector("#cc-copy-btn").addEventListener("click", () => {
      const text = [
        `Commit: ${meta.repo}@${meta.shortSha}`,
        "",
        "Summary:",
        explanation.summary,
        "",
        "Likely motivation:",
        explanation.motivation || "",
        risks.length ? "\nWorth double-checking:" : "",
        ...risks.map((r) => `- ${r}`)
      ].join("\n");
      navigator.clipboard.writeText(text).then(() => flashButton("#cc-copy-btn", "Copied!"));
    });

    root.querySelector("#cc-save-btn").addEventListener("click", () => {
      chrome.runtime.sendMessage(
        {
          type: "CC_SAVE_HISTORY",
          entry: {
            repo: meta.repo,
            filePath: `commit ${meta.shortSha}`,
            lineRange: "",
            codeSnippet: meta.commitMessage,
            explanation: explanation.summary,
            complexity: fileCountLabel,
            interviewQuestions: [],
            url: meta.url
          }
        },
        (response) => {
          if (response?.ok) flashButton("#cc-save-btn", "Saved ✓");
          else flashButton("#cc-save-btn", "Failed to save");
        }
      );
    });
  }

  function flashButton(selector, text) {
    const btn = document.querySelector(selector);
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = text;
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1500);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }

  function showPanel(root) {
    root.classList.remove("cc-panel--hidden");
    requestAnimationFrame(() => root.classList.add("cc-panel--open"));
  }

  function hidePanel(root) {
    root.classList.remove("cc-panel--open");
    setTimeout(() => root.classList.add("cc-panel--hidden"), 200);
  }

  function handleExplainCommit() {
    const info = getCommitInfoFromUrl();
    if (!info) return;

    const commitMessage = getCommitMessage();
    const meta = {
      repo: `${info.owner}/${info.repo}`,
      shortSha: info.sha.slice(0, 7),
      commitMessage,
      url: window.location.href
    };

    const root = ensurePanelRoot();
    root.setAttribute(
      "data-theme",
      document.documentElement.getAttribute("data-code-companion-theme") || "light"
    );

    renderSkeleton(root, meta);
    showPanel(root);

    chrome.runtime.sendMessage(
      {
        type: "CC_EXPLAIN_COMMIT",
        payload: {
          owner: info.owner,
          repo: info.repo,
          sha: info.sha,
          commitMessage,
          url: window.location.href
        }
      },
      (response) => {
        if (!root.isConnected) return; // panel was removed (navigation)
        if (response?.ok) {
          renderCommitExplanation(root, meta, response);
        } else {
          renderError(root, meta, response?.error || "Unknown error");
        }
      }
    );
  }

  function init() {
    const info = getCommitInfoFromUrl();
    const existingFab = document.getElementById(FAB_ID);
    if (!info) {
      if (existingFab) existingFab.remove();
      return;
    }
    ensureFab();
  }

  // Initial load.
  init();

  // GitHub navigates between pages via Turbo without a full reload — re-run
  // setup after each soft navigation, same approach as tree-view.js.
  document.addEventListener("turbo:load", init);
  document.addEventListener("turbo:render", init);

  let lastPath = window.location.pathname;
  const navWatcher = new MutationObserver(() => {
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname;
      setTimeout(init, 300);
    }
  });
  navWatcher.observe(document.body, { childList: true, subtree: true });
})();
