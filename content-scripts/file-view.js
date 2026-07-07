/**
 * content-scripts/file-view.js
 * Runs on github.com/{owner}/{repo}/blob/* pages.
 *
 * Responsibilities:
 *  - Listen for the background worker telling us the "Explain this" context
 *    menu item was clicked, grab the current selection + line range + file
 *    path, and render the slide-in panel.
 *  - The panel calls the background worker (never the LLM/GitHub APIs
 *    directly) and renders the structured JSON response.
 *
 * NOTE: content scripts declared in manifest.json can't use ES `import`, so
 * this file is intentionally self-contained (no shared lib/ imports). Small
 * duplication (e.g. line-range parsing) is preferred here over a bundler.
 */

(function () {
  const PANEL_ID = "code-companion-panel";

  function guessLanguageFromPath(path) {
    const ext = (path.split(".").pop() || "").toLowerCase();
    const map = {
      js: "JavaScript", jsx: "JavaScript (JSX)", ts: "TypeScript", tsx: "TypeScript (TSX)",
      py: "Python", rb: "Ruby", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin",
      c: "C", cpp: "C++", cs: "C#", php: "PHP", swift: "Swift", sh: "Shell",
      yml: "YAML", yaml: "YAML", json: "JSON", md: "Markdown", html: "HTML", css: "CSS"
    };
    return map[ext] || "unknown";
  }

  function parseLineRangeFromLocation() {
    const m = window.location.hash.match(/#?L(\d+)(?:-L(\d+))?/);
    if (!m) return null;
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    return { start, end };
  }

  function getCurrentFilePath() {
    // URL shape: github.com/{owner}/{repo}/blob/{ref}/{path...}
    const m = window.location.pathname.match(/\/[^/]+\/[^/]+\/blob\/[^/]+\/(.+)/);
    return m ? decodeURIComponent(m[1]) : "unknown-file";
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
        <div class="cc-panel__file">${escapeHtml(meta.filePath)}</div>
        <div class="cc-panel__lines">${meta.lineRange}</div>
      </div>
      <div class="cc-panel__body">
        <div class="cc-skeleton"></div>
        <div class="cc-skeleton"></div>
        <div class="cc-skeleton cc-skeleton--short"></div>
        <div class="cc-panel__loading-text">Asking Claude to explain this…</div>
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
        <div class="cc-panel__file">${escapeHtml(meta.filePath)}</div>
        <div class="cc-panel__lines">${meta.lineRange}</div>
      </div>
      <div class="cc-panel__body">
        <div class="cc-panel__error">
          <strong>Couldn't get an explanation.</strong>
          <p>${escapeHtml(message)}</p>
        </div>
      </div>
    `;
    root.querySelector(".cc-panel__close").addEventListener("click", () => hidePanel(root));
  }

  function renderExplanation(root, meta, result) {
    const { explanation, truncated, lineCount } = result;
    const q = explanation.interviewQuestions || [];
    const fragile = explanation.fragilePoint;

    root.innerHTML = `
      <div class="cc-panel__header">
        <div class="cc-panel__title">
          <span class="cc-panel__logo">✨</span>
          <span>Code Companion</span>
        </div>
        <button class="cc-panel__close" aria-label="Close">×</button>
      </div>
      <div class="cc-panel__meta">
        <div class="cc-panel__file">${escapeHtml(meta.filePath)}</div>
        <div class="cc-panel__lines">${meta.lineRange}</div>
      </div>
      <div class="cc-panel__body">
        ${truncated ? `<div class="cc-panel__warning">Selection was ${lineCount} lines — showing a high-level summary instead of a line-by-line explanation.</div>` : ""}

        <section class="cc-section">
          <h3>Explanation</h3>
          <p>${escapeHtml(explanation.explanation)}</p>
        </section>

        <section class="cc-section">
          <h3>Complexity</h3>
          <div class="cc-complexity">
            <span class="cc-badge cc-badge--time">Time: ${escapeHtml(explanation.complexity?.time || "?")}</span>
            <span class="cc-badge cc-badge--space">Space: ${escapeHtml(explanation.complexity?.space || "?")}</span>
          </div>
          <p class="cc-panel__justification">${escapeHtml(explanation.complexity?.justification || "")}</p>
        </section>

        ${q.length ? `
        <section class="cc-section">
          <h3>Likely interview questions</h3>
          <ul class="cc-list">
            ${q.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ul>
        </section>` : ""}

        ${fragile && fragile.description ? `
        <section class="cc-section cc-section--fragile">
          <h3>⚠️ Fragile point</h3>
          <p><strong>${escapeHtml(fragile.description)}</strong></p>
          <p>${escapeHtml(fragile.whatWouldBreak || "")}</p>
        </section>` : ""}
      </div>
      <div class="cc-panel__footer">
        <button class="cc-btn cc-btn--primary" id="cc-save-btn">Save to history</button>
        <button class="cc-btn" id="cc-copy-btn">Copy explanation</button>
      </div>
    `;

    root.querySelector(".cc-panel__close").addEventListener("click", () => hidePanel(root));

    root.querySelector("#cc-copy-btn").addEventListener("click", () => {
      const text = buildCopyText(meta, explanation);
      navigator.clipboard.writeText(text).then(() => flashButton("#cc-copy-btn", "Copied!"));
    });

    root.querySelector("#cc-save-btn").addEventListener("click", () => {
      chrome.runtime.sendMessage(
        {
          type: "CC_SAVE_HISTORY",
          entry: {
            repo: meta.repo,
            filePath: meta.filePath,
            lineRange: meta.lineRange,
            codeSnippet: meta.code,
            explanation: explanation.explanation,
            complexity: `${explanation.complexity?.time || "?"} time / ${explanation.complexity?.space || "?"} space`,
            interviewQuestions: q,
            url: window.location.href.split("#")[0] + `#${meta.lineRange}`
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

  function buildCopyText(meta, explanation) {
    return [
      `File: ${meta.filePath} (${meta.lineRange})`,
      "",
      "Explanation:",
      explanation.explanation,
      "",
      `Time complexity: ${explanation.complexity?.time || "?"}`,
      `Space complexity: ${explanation.complexity?.space || "?"}`,
      explanation.complexity?.justification || "",
      "",
      "Interview questions:",
      ...(explanation.interviewQuestions || []).map((q) => `- ${q}`)
    ].join("\n");
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

  function getRepoIdentifier() {
    const m = window.location.pathname.match(/\/([^/]+)\/([^/]+)\/blob\//);
    return m ? `${m[1]}/${m[2]}` : "unknown/unknown";
  }

  async function handleExplainRequest(selectionText) {
    const code = (selectionText || window.getSelection().toString()).trim();
    if (!code) return;

    const range = parseLineRangeFromLocation();
    const lineRange = range ? `L${range.start}${range.end !== range.start ? `-L${range.end}` : ""}` : "selection";
    const filePath = getCurrentFilePath();
    const repo = getRepoIdentifier();

    const root = ensurePanelRoot();
    root.setAttribute(
      "data-theme",
      document.documentElement.getAttribute("data-code-companion-theme") || "light"
    );

    const meta = { filePath, lineRange, repo, code };
    renderSkeleton(root, meta);
    showPanel(root);

    chrome.runtime.sendMessage(
      {
        type: "CC_EXPLAIN_SNIPPET",
        payload: {
          code,
          filePath,
          url: window.location.href,
          language: guessLanguageFromPath(filePath)
        }
      },
      (response) => {
        if (!root.isConnected) return; // panel was removed (navigation)
        if (response?.ok) {
          renderExplanation(root, meta, response);
        } else {
          renderError(root, meta, response?.error || "Unknown error");
        }
      }
    );
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "CC_OPEN_PANEL_FOR_SELECTION") {
      handleExplainRequest(message.selectionText);
    }
  });

  // GitHub is a Turbo/PJAX-driven SPA — re-check nothing needs cleanup on
  // navigation away from a blob page (panel root just gets removed with the
  // rest of the DOM churn; no persistent listeners to worry about here since
  // we only ever act in response to explicit context-menu clicks).
})();
