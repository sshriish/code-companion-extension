# Code Companion

A Manifest V3 Chrome/Edge extension that helps developers — especially people
who "vibe code" with AI — understand codebases directly on GitHub.com.

Three features:

1. **Explain This** — right-click selected code in a file view, get a
   plain-English explanation, Big-O complexity, likely interview questions,
   and a "what would break" fragile-point callout, in a slide-in panel.
2. **Complexity heatmap** — a colored left-border overlay on the repo file
   tree, computed from a fast client-side cyclomatic-complexity heuristic
   (no LLM call, no cost, near-instant).
3. **History log** — every saved explanation is stored locally and browsable
   from the toolbar popup, grouped by repo, searchable, deep-linkable back
   to the exact GitHub line range.

## Install (unpacked, for development)

1. `chrome://extensions` (or `edge://extensions`) → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Click the Code Companion toolbar icon → **Settings** tab → add:
   - A **GitHub Personal Access Token** (classic, `repo` scope) — needed to
     read file content for private repos and to fetch surrounding context
     for better explanations. Public-repo browsing works without one, just
     at GitHub's lower unauthenticated rate limit.
   - Your **Anthropic API key** — required for "Explain This" and the
     optional deeper complexity opinion. Get one at
     [console.anthropic.com](https://console.anthropic.com).

Both are saved to `chrome.storage.local` by the background service worker
only. Content scripts and the popup UI never read or hold these secrets —
they always go through `chrome.runtime.sendMessage` and let the background
worker make the actual API calls.

## Using it

- **Explain This**: select code inside a `github.com/{owner}/{repo}/blob/*`
  file view, right-click, choose **"Explain this with Code Companion."**
  The panel slides in from the right. Selections over ~200 lines
  automatically switch to a high-level summary instead of a line-by-line
  explanation.
- **Heatmap**: just browse to a repo root or any `tree/*` folder page — rows
  for visible files get a colored left border (🟩 low / 🟨 medium / 🟥 high)
  and a numeric badge on hover. Binary files, images, and lockfiles are
  skipped. Scores are cached per commit SHA + path so revisiting the same
  commit is instant.
- **History**: click the toolbar icon. Search by repo, file, or keyword;
  click an entry to expand the full cached explanation (no re-call to
  Claude); **Revisit on GitHub** deep-links back to the exact line range;
  delete entries individually or clear everything.

## Architecture

```
manifest.json                    # MV3 config: permissions, content scripts, popup
background/service-worker.js     # Only place that holds secrets / calls GitHub + Claude APIs
content-scripts/
  file-view.js                   # Explain This panel (blob pages)
  tree-view.js                   # Complexity heatmap (tree/root pages)
  github-theme-detect.js         # Shared light/dark theme sync
panel/panel.css                  # Primer-matching styles for the injected panel
panel/panel.html                 # Static reference/preview only — not loaded at runtime
popup/                           # Toolbar popup: History tab + Settings tab
lib/
  github-api.js                  # GitHub REST wrapper (rate-limit aware)
  claude-api.js                  # Anthropic Messages API wrapper, strict-JSON prompts
  complexity-heuristic.js        # Client-side cyclomatic-complexity scorer
  storage.js                     # chrome.storage.local helpers (settings/history/cache)
```

**Message flow**: content scripts and the popup never call `api.github.com`
or `api.anthropic.com` directly. Everything goes:

```
content script / popup  --chrome.runtime.sendMessage-->  background/service-worker.js
                                                                |
                                                                +--> lib/github-api.js
                                                                +--> lib/claude-api.js
                                                                +--> lib/storage.js
```

Content scripts declared in `manifest.json` can't use ES `import`, so
`file-view.js` and `tree-view.js` are intentionally self-contained (small
duplication like line-range parsing is preferred over adding a bundler).
`lib/` and `background/service-worker.js` *do* use ES modules, since the
service worker is loaded with `"type": "module"`.

## Design notes

- All LLM prompts request **strict JSON only** (no markdown fences, no
  preamble) so responses parse reliably into distinct UI sections. See the
  system prompts in `lib/claude-api.js`.
- The heatmap only scores files currently in the viewport
  (`IntersectionObserver`), so a 1000+ file repo doesn't trigger a fetch
  storm — file complexity is computed lazily as you scroll, queued with a
  small delay between requests, and backs off for 30s if GitHub returns a
  rate-limit response.
- Complexity scores are cached in `chrome.storage.local` keyed by
  `owner/repo/commitSHA/path`, invalidated automatically because the key
  itself changes once the latest commit touching that path changes.
- The panel and heatmap both read GitHub's own `data-color-mode` attribute
  (falling back to `prefers-color-scheme`) so they match whichever theme
  GitHub is currently in, including live toggles.

## Known limitations / next steps

- **Auth is PAT-based, not full OAuth.** This is the MVP path called out in
  the build order — a GitHub OAuth App (with a proper redirect + token
  exchange, probably needing a small backend or `chrome.identity` flow)
  would remove the manual token-paste step.
- **Surrounding-context fetching is best-effort.** For "Explain This," the
  background worker tries to locate the selected snippet inside the full
  file content to grab ~800 characters of context on each side. If the
  snippet can't be located (e.g. heavily whitespace-normalized selections),
  it silently falls back to explaining the snippet in isolation rather than
  failing the whole request.
- **The complexity heuristic is intentionally not a real parser.** It's a
  weighted regex/token count (McCabe-style: start at 1, +1 per branch
  keyword/operator), not an AST-based analysis, so it can misjudge
  language-specific edge cases (e.g. Rust's `match` arms, or heavily
  macro-driven code). The optional "deeper pass" LLM opinion
  (`CC_GET_COMPLEXITY_OPINION`) exists precisely to catch cases the
  heuristic gets wrong, but it's on-demand only to control API cost.
- **`chrome.storage.local` is used for history**, not `.sync`, since a
  history log can easily exceed the 100KB sync quota. Cross-device history
  would need either a size cap tight enough to fit sync's quota, or a real
  backend.
- **GitHub's DOM is a moving target.** `tree-view.js` tries a few known
  selectors (`react-directory-row`, `folder-row-*`, the older
  `.js-navigation-item`) to stay working across GitHub's ongoing
  react-code-view rollout, but a future markup change may need a selector
  update.

## Permissions used (and why)

| Permission | Why |
|---|---|
| `contextMenus` | Register the "Explain this with Code Companion" right-click item |
| `storage` | `chrome.storage.local` for settings, history, and the complexity cache |
| `activeTab` / `scripting` | Content script injection on GitHub pages |
| `host_permissions: github.com` | Read the DOM / inject UI on file and tree pages |
| `host_permissions: api.github.com` | Fetch file content, trees, and commit history for context + heatmap |
| `host_permissions: api.anthropic.com` | Explanation, summarization, and complexity-opinion calls |
