// Pure helpers for the updater UI. Downloading, signature verification and
// installation all happen in Rust (src-tauri/src/updater.rs).
import type { UpdateChannel, UpdateCheck, UpdateProgress } from './types';

export const PROGRESS_EVENT = 'update://progress';

export const channelOf = (settings: Record<string, unknown>): UpdateChannel => (settings['updates.channel'] === 'beta' ? 'beta' : 'stable');

export const endpointKey = (channel: UpdateChannel) => `updates.endpoint.${channel}`;

/** Percentage 0–100, or null when the total size is unknown (indeterminate bar). */
export function progressPercent(p: UpdateProgress | null): number | null {
  if (!p) return null;
  if (p.phase !== 'downloading') return 100;
  if (!p.total) return null;
  return Math.min(100, Math.floor((p.downloaded / p.total) * 100));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Automatic checks are on unless turned off in Settings → Updates. */
export const autoCheckEnabled = (settings: Record<string, unknown>) => settings['updates.autoCheck'] !== false;

/** How often a running app looks for a new release. */
export const UPDATE_RECHECK_MS = 6 * 60 * 60 * 1000;

/**
 * One automatic check: skipped when turned off; failures are swallowed so an
 * unreachable update server (offline, VPN) never disturbs the app.
 */
export async function autoCheckForUpdates(
  settings: Record<string, unknown>,
  check: () => Promise<UpdateCheck>,
  onResult: (r: UpdateCheck) => void,
): Promise<UpdateCheck | null> {
  if (!autoCheckEnabled(settings)) return null;
  try {
    const r = await check();
    onResult(r);
    return r;
  } catch {
    return null;
  }
}

/** Checks now and then every `everyMs` (settings are re-read each time). Returns a stop function. */
export function startUpdateChecks(
  getSettings: () => Record<string, unknown>,
  check: () => Promise<UpdateCheck>,
  onResult: (r: UpdateCheck) => void,
  everyMs = UPDATE_RECHECK_MS,
): () => void {
  const tick = () => void autoCheckForUpdates(getSettings(), check, onResult);
  tick();
  const id = setInterval(tick, everyMs);
  return () => clearInterval(id);
}
