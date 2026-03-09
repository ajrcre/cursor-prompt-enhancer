import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  HOOKS_DIR,
  HOOKS_JSON,
  HOOK_SCRIPT,
  CONFIG_FILE,
  RESULT_FILE,
  SKIP_FILE,
  HISTORY_FILE,
  HOOK_COMMAND,
  HooksConfig,
} from './utils';

// Injected at build time by esbuild define
declare const __HOOK_SCRIPT_SOURCE__: string;

/** Returns true if our hook is installed and the script file exists */
export function hooksAreInstalled(): boolean {
  if (!fs.existsSync(HOOKS_JSON) || !fs.existsSync(HOOK_SCRIPT)) {
    return false;
  }
  try {
    const json = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf-8'));
    const arr: unknown[] = (json?.hooks?.beforeSubmitPrompt) ?? [];
    return arr.some((e: unknown) => (e as { command?: string }).command === HOOK_COMMAND);
  } catch {
    return false;
  }
}

function writeHookFiles(config: HooksConfig): void {
  if (!fs.existsSync(HOOKS_DIR)) {
    fs.mkdirSync(HOOKS_DIR, { recursive: true });
  }
  fs.writeFileSync(HOOK_SCRIPT, __HOOK_SCRIPT_SOURCE__, { encoding: 'utf-8', mode: 0o755 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

function mergeHooksJson(): void {
  type HooksFile = { version?: number; hooks: Record<string, { command: string; timeout: number }[]> };
  let hooks: HooksFile = { version: 1, hooks: {} };

  if (fs.existsSync(HOOKS_JSON)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf-8')) as HooksFile;
      if (parsed && typeof parsed === 'object') {
        hooks = parsed;
        if (!hooks.hooks || typeof hooks.hooks !== 'object') {
          hooks.hooks = {};
        }
      }
    } catch {
      // Corrupted hooks.json — back it up
      const backup = `${HOOKS_JSON}.backup.${Date.now()}`;
      fs.copyFileSync(HOOKS_JSON, backup);
      hooks = { version: 1, hooks: {} };
    }
  }

  // Register for both events
  for (const event of ['beforeSubmitPrompt', 'afterAgentResponse'] as const) {
    if (!Array.isArray(hooks.hooks[event])) {
      hooks.hooks[event] = [];
    }
    const alreadyPresent = hooks.hooks[event].some(e => e.command === HOOK_COMMAND);
    if (!alreadyPresent) {
      hooks.hooks[event].push({ command: HOOK_COMMAND, timeout: 10 });
    }
  }

  fs.writeFileSync(HOOKS_JSON, JSON.stringify(hooks, null, 2), 'utf-8');
}

/** Install hooks — writes script, config, and merges hooks.json */
export async function installHooks(apiKey: string): Promise<void> {
  const vscodeConfig = vscode.workspace.getConfiguration('promptEnhancer');
  const model = vscodeConfig.get<string>('modelForEnhancement', 'claude-haiku-4-5-20251001');

  const useLocalLlm      = vscodeConfig.get<boolean>('useLocalLlm', false);
  const systemPrompt     = vscodeConfig.get<string>('systemPrompt', '').trim();
  const localLlmEndpoint = vscodeConfig.get<string>('localLlmEndpoint', '').trim();
  const localLlmModel    = vscodeConfig.get<string>('localLlmModel', '').trim();
  const config: HooksConfig = {
    apiKey, model, enabled: true,
    ...(useLocalLlm                  ? { useLocalLlm }      : {}),
    ...(systemPrompt                 ? { systemPrompt }      : {}),
    ...(localLlmEndpoint             ? { localLlmEndpoint }  : {}),
    ...(localLlmModel                ? { localLlmModel }     : {}),
  };
  writeHookFiles(config);
  mergeHooksJson();
}

/** Uninstall — removes hook entries from hooks.json and deletes all managed files */
export function uninstallHooks(): void {
  if (fs.existsSync(HOOKS_JSON)) {
    try {
      type HooksFile = { version?: number; hooks: Record<string, { command: string }[]> };
      const hooks = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf-8')) as HooksFile;
      for (const event of ['beforeSubmitPrompt', 'afterAgentResponse']) {
        if (Array.isArray(hooks?.hooks?.[event])) {
          hooks.hooks[event] = hooks.hooks[event].filter(e => e.command !== HOOK_COMMAND);
        }
      }
      fs.writeFileSync(HOOKS_JSON, JSON.stringify(hooks, null, 2), 'utf-8');
    } catch {
      // Ignore parse errors — nothing to remove
    }
  }

  for (const file of [HOOK_SCRIPT, CONFIG_FILE, RESULT_FILE, SKIP_FILE, HISTORY_FILE]) {
    if (fs.existsSync(file)) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  }
}

/** Update the config file (e.g. when API key changes after hooks are installed).
 *  @param enabledOverride — if provided, overrides the `enabled` field; otherwise preserves from existing config. */
export async function updateConfig(apiKey: string, enabledOverride?: boolean): Promise<void> {
  if (!fs.existsSync(HOOKS_DIR)) {
    return; // Hooks not installed yet — nothing to update
  }
  // Read existing config to preserve values not managed by VS Code settings
  let existingConfig: Partial<HooksConfig> = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      existingConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as Partial<HooksConfig>;
    } catch { /* ignore */ }
  }
  // If no key supplied, preserve whatever is already in the config file
  if (!apiKey) {
    apiKey = existingConfig.apiKey ?? '';
  }
  // Always redeploy the hook script so upgrades take effect without re-running Install Hooks
  fs.writeFileSync(HOOK_SCRIPT, __HOOK_SCRIPT_SOURCE__, { encoding: 'utf-8', mode: 0o755 });
  const vscodeConfig = vscode.workspace.getConfiguration('promptEnhancer');
  const model            = vscodeConfig.get<string>('modelForEnhancement', 'claude-haiku-4-5-20251001');
  const enabled          = enabledOverride ?? existingConfig.enabled ?? true;
  const useLocalLlm      = vscodeConfig.get<boolean>('useLocalLlm', false);
  const systemPrompt     = vscodeConfig.get<string>('systemPrompt', '').trim();
  const localLlmEndpoint = vscodeConfig.get<string>('localLlmEndpoint', '').trim();
  const localLlmModel    = vscodeConfig.get<string>('localLlmModel', '').trim();
  const config: HooksConfig = {
    apiKey, model, enabled,
    ...(useLocalLlm      ? { useLocalLlm }      : {}),
    ...(systemPrompt     ? { systemPrompt }      : {}),
    ...(localLlmEndpoint ? { localLlmEndpoint }  : {}),
    ...(localLlmModel    ? { localLlmModel }     : {}),
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}
