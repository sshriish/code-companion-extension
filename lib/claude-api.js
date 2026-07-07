/**
 * lib/claude-api.js
 * Wrapper for calls to the Anthropic Messages API. Only ever invoked from
 * the background service worker — the API key never reaches a content
 * script or the panel UI directly.
 */

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Strip accidental markdown fences in case the model wraps JSON anyway,
 * despite instructions not to. Defensive parsing > trusting the prompt.
 */
function extractJson(text) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "");
  return JSON.parse(cleaned);
}

async function callClaude({ apiKey, system, prompt, maxTokens = 1200 }) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const textBlock = data.content?.find((b) => b.type === "text");
  if (!textBlock) throw new Error("Claude API returned no text content");
  return textBlock.text;
}

const EXPLAIN_SYSTEM_PROMPT = `You are a senior engineer helping another developer understand a code
snippet inside its repo context. Respond with STRICT JSON ONLY — no markdown
fences, no preamble, no trailing commentary. The JSON must match exactly this
shape:

{
  "explanation": "2-4 sentence plain-English explanation of what the code does",
  "complexity": {
    "time": "Big-O time complexity",
    "space": "Big-O space complexity",
    "justification": "one line explaining why"
  },
  "interviewQuestions": ["question 1", "question 2", "question 3"],
  "fragilePoint": {
    "description": "the most fragile-looking part of this snippet, or null if none stands out",
    "whatWouldBreak": "what would break if it changed, or null"
  }
}

Do not include any text outside this JSON object.`;

/**
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} args.code - the selected snippet
 * @param {string} args.filePath
 * @param {string} args.language - best-guess language from file extension
 * @param {string} [args.surroundingContext] - optional extra context (e.g. enclosing function)
 * @returns {Promise<object>} parsed structured explanation
 */
export async function explainSnippet({ apiKey, code, filePath, language, surroundingContext }) {
  const prompt = `File: ${filePath}
Language: ${language || "unknown"}
${surroundingContext ? `Surrounding context:\n${surroundingContext}\n` : ""}
Snippet to explain:
\`\`\`
${code}
\`\`\`

Respond with the JSON object described in your system instructions.`;

  const text = await callClaude({ apiKey, system: EXPLAIN_SYSTEM_PROMPT, prompt, maxTokens: 1200 });
  return extractJson(text);
}

const SUMMARIZE_SYSTEM_PROMPT = `You are a senior engineer summarizing a large code selection (too long for a
line-by-line walkthrough). Respond with STRICT JSON ONLY, no markdown fences,
matching:

{
  "explanation": "3-5 sentence high-level summary of what this block of code accomplishes and its overall structure",
  "complexity": {
    "time": "Big-O time complexity of the dominant operation",
    "space": "Big-O space complexity",
    "justification": "one line explaining why"
  },
  "interviewQuestions": ["question 1", "question 2"],
  "fragilePoint": { "description": null, "whatWouldBreak": null }
}`;

export async function summarizeLargeSnippet({ apiKey, code, filePath, language }) {
  const prompt = `File: ${filePath}
Language: ${language || "unknown"}

Large snippet to summarize:
\`\`\`
${code}
\`\`\`

Respond with the JSON object described in your system instructions.`;
  const text = await callClaude({ apiKey, system: SUMMARIZE_SYSTEM_PROMPT, prompt, maxTokens: 900 });
  return extractJson(text);
}

const COMPLEXITY_OPINION_SYSTEM_PROMPT = `You are a senior engineer giving a second opinion on a file's complexity,
beyond a simple cyclomatic-complexity heuristic. Respond with STRICT JSON
ONLY matching:

{
  "opinion": "2-3 sentence assessment of why this file is or isn't actually complex to work in",
  "hotspots": ["short description of hotspot 1", "short description of hotspot 2"]
}`;

export async function getComplexityOpinion({ apiKey, filePath, code, heuristicScore }) {
  const prompt = `File: ${filePath}
Heuristic cyclomatic-complexity score: ${heuristicScore}

File content (may be truncated):
\`\`\`
${code}
\`\`\`

Respond with the JSON object described in your system instructions.`;
  const text = await callClaude({
    apiKey,
    system: COMPLEXITY_OPINION_SYSTEM_PROMPT,
    prompt,
    maxTokens: 500
  });
  return extractJson(text);
}
