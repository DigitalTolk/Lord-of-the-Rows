import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import { useApp } from '../store';
import { UpdateButton } from './UpdateButton';

describe('UpdateButton', () => {
  afterEach(cleanup);
  beforeEach(() => useApp.setState({ update: null, settingsSection: null, tabs: [], activeTab: undefined, launcher: true }));

  it('is hidden until a newer release is known', () => {
    const { container } = render(<UpdateButton />);
    expect(container.childElementCount).toBe(0);
  });

  it('names the version and opens Settings → Updates', () => {
    useApp.setState({ update: { status: 'available', channel: 'stable', current_version: '0.2.0', version: '0.2.1' } });
    render(<UpdateButton />);
    const btn = screen.getByRole('button', { name: /update 0\.2\.1/i });
    expect(btn.getAttribute('title')).toContain('you have 0.2.0');
    fireEvent.click(btn);
    const st = useApp.getState();
    expect(st.launcher).toBe(false);
    expect(st.settingsSection).toBe('updates');
    expect(st.tabs.find((t) => t.id === st.activeTab)?.kind).toBe('settings');
  });
});
