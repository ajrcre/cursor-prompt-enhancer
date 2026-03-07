import * as fs from 'fs';
import * as vscode from 'vscode';
import { startWatching, readResult } from './fileWatcher';
import {
  installHooks,
  uninstallHooks,
  hooksAreInstalled,
  updateConfig,
} from './hookInstaller';
import { SECRET_KEY_NAME, SKIP_FILE, EnhancerResult, estimateTokens } from './utils';

// ── Skip flag ────────────────────────────────────────────────────────────────

function writeSkipFlag(): void {
  try {
    fs.writeFileSync(SKIP_FILE, JSON.stringify({ createdAt: Date.now() }), 'utf-8');
  } catch {
    // Non-fatal — worst case the next submission gets intercepted once more
  }
}

// ── QuickPick ────────────────────────────────────────────────────────────────

interface PromptPickItem extends vscode.QuickPickItem {
  promptText: string;
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.substring(0, maxLen) + '…' : text;
}

const PREVIEW_LABEL = '$(eye) Preview Enhanced Prompt';

async function showPromptQuickPick(result: EnhancerResult): Promise<void> {
  const origTokens = estimateTokens(result.original_prompt);
  const enhTokens  = estimateTokens(result.enhanced_prompt);
  const tierIcon   = result.model_recommendation === 'easy' ? '💚' : result.model_recommendation === 'medium' ? '🟡' : '🟠';

  const items: PromptPickItem[] = [
    {
      label:       '$(sparkle) Use Enhanced',
      description: `${tierIcon} ${result.model_name} · ~${enhTokens} tokens`,
      detail:      truncate(result.enhanced_prompt, 150),
      promptText:  result.enhanced_prompt,
    },
    {
      label:       '$(circle-slash) Use Original',
      description: `~${origTokens} tokens`,
      detail:      truncate(result.original_prompt, 150),
      promptText:  result.original_prompt,
    },
    {
      label:       PREVIEW_LABEL,
      description: 'Open full text in editor — picker will re-appear',
      detail:      '',
      promptText:  '',
    },
  ];

  const selected = await vscode.window.showQuickPick(items, {
    title:       '✨ Prompt Enhanced',
    placeHolder: result.model_reason,
  });

  if (!selected) {
    return;
  }

  if (selected.label === PREVIEW_LABEL) {
    const doc = await vscode.workspace.openTextDocument({
      content: result.enhanced_prompt,
      language: 'markdown',
    });
    await vscode.window.showTextDocument(doc, {
      preview: true,
      viewColumn: vscode.ViewColumn.Beside,
    });
    // Re-show the picker so the user can still choose after reading
    await showPromptQuickPick(result);
    return;
  }

  writeSkipFlag();
  await vscode.env.clipboard.writeText(selected.promptText);

  vscode.window.showInformationMessage(
    selected.label.includes('Enhanced')
      ? '✨ Enhanced prompt copied! Paste (⌘V) into chat and submit.'
      : 'Original prompt copied! Paste (⌘V) into chat and submit.'
  );
}

// ── Activation ───────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Watch for new enhancement results → show QuickPick automatically
  startWatching(context, (result) => {
    showPromptQuickPick(result).catch(() => { /* ignore */ });
  });

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('promptEnhancer.setApiKey', async () => {
      const existing = await context.secrets.get(SECRET_KEY_NAME);
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your Anthropic API key (starts with sk-ant-...)',
        password: true,
        value: existing ?? '',
        placeHolder: 'sk-ant-api03-...',
        validateInput: (v) =>
          v.trim().startsWith('sk-ant-') ? null : 'Key should start with sk-ant-',
      });
      if (!key) { return; }
      await context.secrets.store(SECRET_KEY_NAME, key.trim());
      vscode.window.showInformationMessage('API key saved.');

      // If hooks are already installed, update the config file with the new key
      if (hooksAreInstalled()) {
        await updateConfig(key.trim());
      } else {
        const install = await vscode.window.showInformationMessage(
          'Hooks are not installed yet. Install them now?',
          'Install Hooks',
          'Later'
        );
        if (install === 'Install Hooks') {
          await vscode.commands.executeCommand('promptEnhancer.installHooks');
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('promptEnhancer.installHooks', async () => {
      let apiKey = await context.secrets.get(SECRET_KEY_NAME);
      if (!apiKey) {
        const entered = await vscode.window.showInputBox({
          prompt: 'No API key found. Enter your Anthropic API key to continue.',
          password: true,
          placeHolder: 'sk-ant-api03-...',
          validateInput: (v) =>
            v.trim().startsWith('sk-ant-') ? null : 'Key should start with sk-ant-',
        });
        if (!entered) { return; }
        await context.secrets.store(SECRET_KEY_NAME, entered.trim());
        apiKey = entered.trim();
      }
      try {
        await installHooks(apiKey);
        vscode.window.showInformationMessage(
          '✅ Prompt Enhancer hooks installed! Your next Cursor AI prompt will be enhanced automatically.'
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to install hooks: ${String(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('promptEnhancer.uninstallHooks', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Uninstall Prompt Enhancer hooks? Prompts will no longer be enhanced automatically.',
        'Uninstall',
        'Cancel'
      );
      if (confirm !== 'Uninstall') { return; }
      try {
        uninstallHooks();
        vscode.window.showInformationMessage('Hooks uninstalled.');
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to uninstall hooks: ${String(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('promptEnhancer.showLastResult', async () => {
      const result = readResult();
      if (!result) {
        vscode.window.showInformationMessage(
          'No enhanced prompt available yet. Submit a prompt in Cursor chat to get started.'
        );
        return;
      }
      await showPromptQuickPick(result);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('promptEnhancer.editSystemPrompt', async () => {
      const vscodeConfig = vscode.workspace.getConfiguration('promptEnhancer');
      const inspected = vscodeConfig.inspect<string>('systemPrompt');
      const current = vscodeConfig.get<string>('systemPrompt');
      // Use the current explicit value if set, otherwise seed from the package.json default
      const effective = (current && current.trim())
        ? current
        : ((inspected?.defaultValue as string) || '');
      // Write explicitly to user settings so it shows up in settings.json
      await vscodeConfig.update('systemPrompt', effective, vscode.ConfigurationTarget.Global);
      // Open settings.json for proper multiline editing
      await vscode.commands.executeCommand('workbench.action.openSettingsJson');
    })
  );

  // Auto-update config when any promptEnhancer setting changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('promptEnhancer')) {
        const apiKey = await context.secrets.get(SECRET_KEY_NAME);
        if (apiKey) { await updateConfig(apiKey); }
      }
    })
  );

  // First-run onboarding (runs after startup)
  setTimeout(async () => {
    const apiKey = await context.secrets.get(SECRET_KEY_NAME);
    if (!apiKey) {
      const action = await vscode.window.showInformationMessage(
        '✨ Prompt Enhancer: Set your Anthropic API key to start enhancing Cursor prompts.',
        'Set API Key',
        'Get a Key'
      );
      if (action === 'Set API Key') {
        vscode.commands.executeCommand('promptEnhancer.setApiKey');
      } else if (action === 'Get a Key') {
        vscode.env.openExternal(vscode.Uri.parse('https://console.anthropic.com/'));
      }
    } else if (!hooksAreInstalled()) {
      const action = await vscode.window.showInformationMessage(
        '✨ Prompt Enhancer is ready. Install hooks to automatically enhance prompts before submission.',
        'Install Hooks',
        'Later'
      );
      if (action === 'Install Hooks') {
        vscode.commands.executeCommand('promptEnhancer.installHooks');
      }
    }
  }, 2000); // Wait 2s after activation for Cursor to finish loading
}

export function deactivate(): void {
  // File watcher is disposed automatically via context.subscriptions
}
