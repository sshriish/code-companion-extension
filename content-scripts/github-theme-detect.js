/**
 * content-scripts/github-theme-detect.js
 * Shared utility (loaded before file-view.js / tree-view.js) that figures
 * out whether GitHub is currently in light or dark mode, and keeps our
 * injected UI in sync if the user flips it live.
 *
 * GitHub sets `data-color-mode` ("light" | "dark" | "auto") and
 * `data-{light,dark}-theme` on <html>. When mode is "auto" we fall back to
 * prefers-color-scheme.
 */

window.CodeCompanionTheme = (function () {
  function resolve() {
    const html = document.documentElement;
    const mode = html.getAttribute("data-color-mode") || "auto";

    if (mode === "dark") return "dark";
    if (mode === "light") return "light";

    // auto -> OS preference
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function applyThemeAttribute() {
    document.documentElement.setAttribute("data-code-companion-theme", resolve());
  }

  applyThemeAttribute();

  // React to GitHub toggling theme at runtime.
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes" && m.attributeName === "data-color-mode") {
        applyThemeAttribute();
      }
    }
  });
  observer.observe(document.documentElement, { attributes: true });

  // React to OS-level scheme changes when mode is "auto".
  if (window.matchMedia) {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", applyThemeAttribute);
  }

  return {
    current: resolve
  };
})();
