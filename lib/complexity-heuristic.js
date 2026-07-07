/**
 * lib/complexity-heuristic.js
 * Zero-cost, client-side approximation of cyclomatic complexity. This is
 * intentionally simple (regex/token counting, not a real AST parser) so it
 * runs instantly on hundreds of files without a build step or LLM call.
 *
 * Score = weighted count of branching keywords/operators, normalized a bit
 * by file length so a single huge-but-simple file doesn't always look
 * "high complexity" purely from volume.
 */

// Extensions we skip entirely — binary, generated, or lockfiles where a
// complexity score is meaningless or misleading.
const SKIP_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "svg", "bmp",
  "woff", "woff2", "ttf", "eot", "otf",
  "zip", "gz", "tar", "7z", "rar",
  "pdf", "mp4", "mov", "mp3", "wav",
  "lock" // e.g. Cargo.lock, .lock generally
]);

const SKIP_FILENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "composer.lock",
  "Gemfile.lock",
  "Cargo.lock",
  "poetry.lock",
  "go.sum"
]);

// Branching constructs we count, roughly language-agnostic. Each match adds
// 1 to the raw complexity count (standard McCabe-style approximation: start
// at 1, +1 per decision point).
const BRANCH_PATTERNS = [
  /\bif\b/g,
  /\belse\s+if\b/g,
  /\bfor\b/g,
  /\bwhile\b/g,
  /\bcase\b/g,
  /\bcatch\b/g,
  /\?\s*[^:]+:/g, // ternary
  /&&/g,
  /\|\|/g,
  /\belif\b/g, // python
  /\bexcept\b/g // python
];

// Rough "function boundary" detector across common languages, used only to
// normalize by function count so we're approximating complexity-per-function
// rather than a raw file-wide sum.
const FUNCTION_PATTERNS = [
  /\bfunction\s+\w+\s*\(/g,
  /\bdef\s+\w+\s*\(/g,
  /=>\s*{/g,
  /\b\w+\s*\([^)]*\)\s*{/g
];

export function shouldSkipFile(filePath) {
  const filename = filePath.split("/").pop() || "";
  if (SKIP_FILENAMES.has(filename)) return true;
  const ext = filename.includes(".") ? filename.split(".").pop().toLowerCase() : "";
  return SKIP_EXTENSIONS.has(ext);
}

function countMatches(source, pattern) {
  const matches = source.match(pattern);
  return matches ? matches.length : 0;
}

/**
 * @param {string} source - full file text
 * @returns {{ score: number, band: 'low'|'medium'|'high', raw: number, functionCount: number }}
 */
export function scoreComplexity(source) {
  if (!source || !source.trim()) {
    return { score: 0, band: "low", raw: 0, functionCount: 0 };
  }

  const raw = BRANCH_PATTERNS.reduce((sum, pattern) => sum + countMatches(source, pattern), 1);
  const functionCount = Math.max(
    1,
    FUNCTION_PATTERNS.reduce((sum, pattern) => sum + countMatches(source, pattern), 0)
  );

  // Complexity per function, then lightly scaled by log(file length) so very
  // long files trend a bit higher even at similar per-function density.
  const lengthFactor = Math.log2(Math.max(source.length, 100) / 100) + 1;
  const score = Math.round((raw / functionCount) * lengthFactor * 10) / 10;

  let band = "low";
  if (score >= 15) band = "high";
  else if (score >= 6) band = "medium";

  return { score, band, raw, functionCount };
}

export function bandToEmoji(band) {
  return { low: "🟩", medium: "🟨", high: "🟥" }[band] || "⬜";
}

export function bandToColor(band) {
  // Matches GitHub-ish semantic colors, subtle enough to sit as a left border.
  return {
    low: "#2da44e",
    medium: "#d4a72c",
    high: "#cf222e"
  }[band] || "transparent";
}
