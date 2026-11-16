import { describe, expect, it, vi } from 'vitest';
import { autoCheckEnabled, autoCheckForUpdates, channelOf, endpointKey, formatBytes, progressPercent, startUpdateChecks } from './updates';
import type { UpdateCheck } from './types';

const available: UpdateCheck = { status: 'available', channel: 'stable', current_version: '0.1.0', version: '0.2.0', notes: 'n' };

describe('updates', () => {
  it('checks automatically unless turned off', async () => {
    const check = vi.fn(async () => available);
    const onResult = vi.fn();
    expect(autoCheckEnabled({})).toBe(true);
    expect(autoCheckEnabled({ 'updates.autoCheck': false })).toBe(false);
    expect(await autoCheckForUpdates({ 'updates.autoCheck': false }, check, onResult)).toBeNull();
    expect(check).not.toHaveBeenCalled();
    expect(await autoCheckForUpdates({}, check, onResult)).toEqual(available);
    expect(onResult).toHaveBeenCalledWith(available);
  });

  it('swallows check failures and reports every result', async () => {
    const onResult = vi.fn();
    expect(await autoCheckForUpdates({}, () => Promise.reject(new Error('offline')), onResult)).toBeNull();
    expect(onResult).not.toHaveBeenCalled();
    const upToDate: UpdateCheck = { status: 'up_to_date', channel: 'stable', current_version: '0.1.0' };
    await autoCheckForUpdates({}, async () => upToDate, onResult);
    expect(onResult).toHaveBeenCalledWith(upToDate);
  });

  it('re-checks on an interval with fresh settings until stopped', async () => {
    vi.useFakeTimers();
    try {
      let settings: Record<string, unknown> = {};
      const check = vi.fn(async () => available);
      const stop = startUpdateChecks(() => settings, check, () => {}, 1000);
      expect(check).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(check).toHaveBeenCalledTimes(2);
      settings = { 'updates.autoCheck': false };
      await vi.advanceTimersByTimeAsync(1000);
      expect(check).toHaveBeenCalledTimes(2);
      settings = {};
      stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(check).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('computes progress and resolves channel settings', () => {
    expect(progressPercent(null)).toBeNull();
    expect(progressPercent({ phase: 'downloading', downloaded: 50, total: null })).toBeNull();
    expect(progressPercent({ phase: 'downloading', downloaded: 50, total: 200 })).toBe(25);
    expect(progressPercent({ phase: 'downloading', downloaded: 300, total: 200 })).toBe(100);
    expect(progressPercent({ phase: 'verifying' })).toBe(100);
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(channelOf({})).toBe('stable');
    expect(channelOf({ 'updates.channel': 'beta' })).toBe('beta');
    expect(channelOf({ 'updates.channel': 'nightly' })).toBe('stable');
    expect(endpointKey('beta')).toBe('updates.endpoint.beta');
  });
});
