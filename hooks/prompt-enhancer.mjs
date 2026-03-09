#!/usr/bin/env node

/**
 * Cursor Prompt Enhancer — Hook Script
 * Auto-managed by the Cursor Prompt Enhancer extension.
 * Do not edit manually — changes will be overwritten on hook reinstall.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const HOOKS_DIR    = join(homedir(), '.cursor', 'hooks');
const CONFIG_FILE  = join(HOOKS_DIR, 'prompt-enhancer-config.json');
const RESULT_FILE  = join(HOOKS_DIR, 'prompt-enhancer-result.json');
const SKIP_FILE    = join(HOOKS_DIR, 'prompt-enhancer-skip.flag');
const HISTORY_FILE = join(HOOKS_DIR, 'prompt-enhancer-history.json');

const MAX_HISTORY_TURNS    = 10;  // max turns stored per conversation
const MAX_CONTEXT_TURNS    = 3;   // max turns sent to Claude for context
const HISTORY_TTL_MS       = 24 * 60 * 60 * 1000; // 24 hours
const SKIP_FLAG_TTL_MS     = 30 * 1000;            // 30 seconds

// ── Config ──────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch { /* fall through */ }
  return null;
}

// ── Skip flag ────────────────────────────────────────────────────────────────

/** Returns true and deletes the flag if a valid (fresh) skip flag exists. */
function checkAndConsumeSkipFlag() {
  if (!existsSync(SKIP_FILE)) { return false; }
  try {
    const data = JSON.parse(readFileSync(SKIP_FILE, 'utf-8'));
    unlinkSync(SKIP_FILE);
    return (Date.now() - (data.createdAt ?? 0)) < SKIP_FLAG_TTL_MS;
  } catch {
    try { unlinkSync(SKIP_FILE); } catch { /* ignore */ }
    return false;
  }
}

// ── Conversation history ─────────────────────────────────────────────────────

function loadHistory() {
  try {
    if (existsSync(HISTORY_FILE)) {
      return JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
    }
  } catch { /* fall through */ }
  return { conversations: {} };
}

function saveHistory(history) {
  try {
    if (!existsSync(HOOKS_DIR)) { mkdirSync(HOOKS_DIR, { recursive: true }); }
    writeFileSync(HISTORY_FILE, JSON.stringify(history), 'utf-8');
  } catch { /* non-fatal */ }
}

function pruneHistory(history) {
  const cutoff = Date.now() - HISTORY_TTL_MS;
  for (const id of Object.keys(history.conversations)) {
    if ((history.conversations[id].lastUpdatedAt ?? 0) < cutoff) {
      delete history.conversations[id];
    }
  }
}

/** Get last N completed turns (where assistant is not null) for a conversation. */
function getCompletedTurns(history, conversationId) {
  const conv = history.conversations[conversationId];
  if (!conv) { return []; }
  return conv.turns
    .filter(t => t.assistant !== null)
    .slice(-MAX_CONTEXT_TURNS);
}

/** Append a new pending user turn. */
function addPendingTurn(history, conversationId, userPrompt) {
  if (!history.conversations[conversationId]) {
    history.conversations[conversationId] = { lastUpdatedAt: Date.now(), turns: [] };
  }
  const conv = history.conversations[conversationId];
  conv.turns.push({ user: userPrompt, assistant: null });
  // Keep max turns
  if (conv.turns.length > MAX_HISTORY_TURNS) {
    conv.turns = conv.turns.slice(-MAX_HISTORY_TURNS);
  }
  conv.lastUpdatedAt = Date.now();
}

/** Complete the last pending turn with the assistant response. */
function completePendingTurn(history, conversationId, assistantText) {
  const conv = history.conversations[conversationId];
  if (!conv) { return; }
  // Find last turn with null assistant
  for (let i = conv.turns.length - 1; i >= 0; i--) {
    if (conv.turns[i].assistant === null) {
      conv.turns[i].assistant = assistantText;
      conv.lastUpdatedAt = Date.now();
      return;
    }
  }
}

// ── Claude API ───────────────────────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `<!-- CONFIGURATION: Update these model lists to match your available models -->
COMPLEX_MODELS: ["claude-opus-4.6", "gpt-5.4-pro"]
MEDIUM_MODELS: ["claude-sonnet-4.6"]
EASY_MODELS: ["claude-haiku-4.5", "gpt-5-nano", "gemini-3.1-flash-lite"]
<!-- END CONFIGURATION -->
You are a prompt engineering expert specializing in AI coding assistants.
Your job is to enhance prompts to be clearer, more specific, and more token-efficient.
Apply these improvements when relevant:
- Be explicit about desired output format and constraints
- Add context and motivation behind the request
- Break multi-step instructions into numbered steps
- Remove ambiguity and vague language
- Make implicit requirements explicit
- Trim redundant words while preserving full meaning
- Use XML tags to structure complex prompts with multiple components
- Use the conversation history to resolve pronouns ("that", "it", "this") and maintain topic continuity
- Preserve the original language of the prompt (e.g. if the prompt is in Hebrew, the enhanced version should also be in Hebrew)
- Do NOT make the enhanced prompt more than 2x the length of the original
- If the prompt is already excellent, keep it as-is (do not change for the sake of changing)
After enhancing the prompt, append the sentence "think before acting" ONLY if the task is non-trivial (i.e., requires reasoning, multiple steps, or has side effects). Omit it for simple lookups, formatting tasks, or one-liners.
Assess model complexity using exactly one of three tiers:
- "easy"    = simple Q&A, formatting tasks, short code snippets, syntax questions, single-step tasks
- "medium"  = moderate reasoning, single-file refactors, API usage questions, debugging with clear context
- "complex" = architecture decisions, deep reasoning, large refactors, long-context analysis, security review, multi-file changes
Select model_name from the matching tier's list (EASY_MODELS, MEDIUM_MODELS, or COMPLEX_MODELS).
If uncertain between two tiers, prefer the cheaper one.
Return ONLY valid JSON with no markdown fences or extra text:
{
  "enhanced_prompt": "the improved prompt text",
  "model_recommendation": "easy" | "medium" | "complex",
  "model_name": "<selected from the configured model lists above>",
  "model_reason": "one concise sentence explaining the recommendation",
  "changes_summary": "one to two sentences describing what was improved (or 'No changes needed' if already optimal)",
  "prompt_quality_score": <integer 1-10 reflecting quality of the ENHANCED prompt>
}`;

function buildUserMessage(currentPrompt, completedTurns) {
  if (completedTurns.length === 0) {
    return `<current_prompt>\n${currentPrompt}\n</current_prompt>`;
  }

  const historyXml = completedTurns
    .map((t, i) =>
      `<turn index="${i + 1}">\n<user>${t.user}</user>\n<assistant>${t.assistant}</assistant>\n</turn>`
    )
    .join('\n');

  return `<conversation_history>\n${historyXml}\n</conversation_history>\n\n<current_prompt>\n${currentPrompt}\n</current_prompt>`;
}

async function callClaudeApi(apiKey, model, currentPrompt, completedTurns, systemPrompt, timeoutMs = 3500) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: buildUserMessage(currentPrompt, completedTurns) }],
      }),
    });

    clearTimeout(timeoutId);
    if (!response.ok) { return null; }

    const data = await response.json();
    const rawText = data.content?.[0]?.text ?? '';
    const jsonText = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    return JSON.parse(jsonText);
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

async function callLocalLlmApi(endpoint, model, currentPrompt, completedTurns, systemPrompt, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = endpoint.replace(/\/$/, '') + '/chat/completions';
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: buildUserMessage(currentPrompt, completedTurns) },
        ],
      }),
    });
    clearTimeout(timeoutId);
    if (!response.ok) { return null; }
    const data = await response.json();
    const raw = (data.choices?.[0]?.message?.content ?? '').trim();
    const jsonText = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(jsonText);
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

// ── Event handlers ───────────────────────────────────────────────────────────

async function handleBeforeSubmitPrompt(input) {
  // 1. Check skip flag first — user just chose enhanced/original, let it through
  if (checkAndConsumeSkipFlag()) {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  const config = loadConfig();
  const usingLocal = !!(config?.localLlmEndpoint && config?.localLlmModel);
  if (!config?.apiKey && !usingLocal) {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }
  if (config.enabled === false) {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  const originalPrompt = input.prompt || '';
  const composerMode   = input.composer_mode || '';

  // Diagnostic: log every beforeSubmitPrompt call to help understand Agent/Plan mode behavior
  try {
    const logLine = JSON.stringify({
      ts:        new Date().toISOString(),
      mode:      composerMode,
      model:     input.model || '',
      promptLen: originalPrompt.length,
      preview:   originalPrompt.substring(0, 80).replace(/\n/g, '↵'),
    }) + '\n';
    appendFileSync(join(HOOKS_DIR, 'prompt-enhancer-debug.log'), logLine, 'utf-8');
  } catch { /* non-fatal */ }

  if (originalPrompt.trim().length < 5) {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  // In Agent/Plan mode, only enhance clearly user-typed short prompts.
  // Long prompts in those modes are almost always full agent context (system
  // instructions + file contents + user message concatenated), which would
  // exceed the 3.5 s API timeout and cannot be meaningfully "enhanced" anyway.
  const MAX_PROMPT_LEN = composerMode === 'ask' ? 4000 : 600;
  if (originalPrompt.length > MAX_PROMPT_LEN) {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  const conversationId = input.conversation_id ?? '';
  const model = config.model || 'claude-haiku-4-5-20251001';

  // 2. Load history and get context for this conversation
  const history = loadHistory();
  const completedTurns = getCompletedTurns(history, conversationId);

  // 3. Record this prompt as a pending turn (before blocking, so it persists even if we timeout)
  if (conversationId) {
    addPendingTurn(history, conversationId, originalPrompt);
    pruneHistory(history);
    saveHistory(history);
  }

  // 4. Call API (local or Claude) with context
  const systemPrompt = (config.systemPrompt && config.systemPrompt.trim()) ? config.systemPrompt.trim() : DEFAULT_SYSTEM_PROMPT;
  const timeoutMs = usingLocal ? 8000 : 3500;
  const result = usingLocal
    ? await callLocalLlmApi(config.localLlmEndpoint, config.localLlmModel, originalPrompt, completedTurns, systemPrompt, timeoutMs)
    : await callClaudeApi(config.apiKey, model, originalPrompt, completedTurns, systemPrompt, timeoutMs);

  if (!result) {
    // Timeout or error — always pass through
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  // 5. Write result file for the VS Code extension
  const resultData = {
    timestamp: Date.now(),
    conversation_id: conversationId,
    original_prompt: originalPrompt,
    enhanced_prompt: result.enhanced_prompt,
    model_recommendation: result.model_recommendation,
    model_name: result.model_name,
    model_reason: result.model_reason,
    changes_summary: result.changes_summary,
  };

  try {
    if (!existsSync(HOOKS_DIR)) { mkdirSync(HOOKS_DIR, { recursive: true }); }
    writeFileSync(RESULT_FILE, JSON.stringify(resultData, null, 2), 'utf-8');
  } catch { /* non-fatal */ }

  // 6. Block submission
  process.stdout.write(JSON.stringify({
    continue: false,
    user_message: '✨ Prompt enhanced! Select your preferred version in the popup that appeared in Cursor.',
  }));
  process.exit(0);
}

function handleAfterAgentResponse(input) {
  const conversationId = input.conversation_id ?? '';
  const assistantText = input.text ?? '';
  if (!conversationId) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  const history = loadHistory();
  completePendingTurn(history, conversationId, assistantText);
  pruneHistory(history);
  saveHistory(history);

  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let inputData = '';
  for await (const chunk of process.stdin) { inputData += chunk; }

  let input;
  try {
    input = JSON.parse(inputData);
  } catch {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  switch (input.hook_event_name) {
    case 'beforeSubmitPrompt':
      await handleBeforeSubmitPrompt(input);
      break;
    case 'afterAgentResponse':
      handleAfterAgentResponse(input);
      break;
    default:
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
  }
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
