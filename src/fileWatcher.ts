import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { RESULT_FILE, EnhancerResult, debounce } from './utils';

type ResultCallback = (result: EnhancerResult) => void;

export function readResult(): EnhancerResult | null {
  try {
    const raw = fs.readFileSync(RESULT_FILE, 'utf-8');
    return JSON.parse(raw) as EnhancerResult;
  } catch {
    return null;
  }
}

/**
 * Watch the result file using VS Code's built-in file system watcher (primary)
 * plus a 500ms polling fallback for when the watcher misses changes from
 * external processes (known issue with Cursor's Agent/Plan modes on macOS).
 *
 * A `lastTimestamp` guard ensures the QuickPick only appears once per
 * new result, regardless of which mechanism fires first.
 */
export function startWatching(
  context: vscode.ExtensionContext,
  onResult: ResultCallback
): void {
  let lastTimestamp = 0;

  // Shared handler — debounced and timestamp-guarded to avoid duplicate shows
  const handleNewResult = debounce(() => {
    const result = readResult();
    if (result && result.timestamp > lastTimestamp) {
      lastTimestamp = result.timestamp;
      onResult(result);
    }
  }, 100);

  // ── Primary: VS Code file system watcher ─────────────────────────────────
  const dir = path.dirname(RESULT_FILE);
  const basename = path.basename(RESULT_FILE);
  const pattern = new vscode.RelativePattern(vscode.Uri.file(dir), basename);
  const vsWatcher = vscode.workspace.createFileSystemWatcher(pattern);

  vsWatcher.onDidChange(handleNewResult, null, context.subscriptions);
  vsWatcher.onDidCreate(handleNewResult, null, context.subscriptions);

  // Auto-disposed when the extension deactivates via context.subscriptions
  context.subscriptions.push(vsWatcher);

  // ── Fallback: poll every 500ms ────────────────────────────────────────────
  // Catches file changes the VS Code watcher misses in Cursor's Agent/Plan
  // modes (chokidar also unreliable when Cursor sandboxes subprocesses).
  const poll = setInterval(() => handleNewResult(), 500);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });
}
