import * as path from 'path';
import * as os from 'os';

export const CURSOR_DIR   = path.join(os.homedir(), '.cursor');
export const HOOKS_DIR    = path.join(CURSOR_DIR, 'hooks');
export const HOOKS_JSON   = path.join(CURSOR_DIR, 'hooks.json');
export const HOOK_SCRIPT  = path.join(HOOKS_DIR, 'prompt-enhancer.mjs');
export const CONFIG_FILE  = path.join(HOOKS_DIR, 'prompt-enhancer-config.json');
export const RESULT_FILE  = path.join(HOOKS_DIR, 'prompt-enhancer-result.json');
export const SKIP_FILE    = path.join(HOOKS_DIR, 'prompt-enhancer-skip.flag');
export const HISTORY_FILE = path.join(HOOKS_DIR, 'prompt-enhancer-history.json');

export const HOOK_COMMAND    = 'node ./hooks/prompt-enhancer.mjs';
export const SECRET_KEY_NAME = 'promptEnhancer.apiKey';

export interface EnhancerResult {
  timestamp: number;
  conversation_id: string;
  original_prompt: string;
  enhanced_prompt: string;
  model_recommendation: 'easy' | 'medium' | 'complex';
  model_name: string;
  model_reason: string;
  changes_summary: string;
  prompt_quality_score: number;
}

export interface HooksConfig {
  apiKey: string;
  model: string;
  enabled: boolean;
  systemPrompt?: string;
}

/** Rough token count estimate (characters / 4) */
export function estimateTokens(text: string): number {
  return Math.round(text.length / 4);
}

/** Simple debounce helper */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    if (timer) { clearTimeout(timer); }
    timer = setTimeout(() => fn(...args), delay);
  };
}
