import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { ErrorBox } from './ui';

afterEach(cleanup);

describe('ErrorBox', () => {
  it('shows the error as selectable text and copies it', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const msg = "Table 'shop.nope' doesn't exist [1146 (42S02)]";
    render(<ErrorBox error={msg} />);
    expect(screen.getByText(msg).className).toContain('selectable');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy error message' }));
    });
    expect(writeText).toHaveBeenCalledWith(msg);
    expect(screen.getByRole('button', { name: 'Copy error message' }).textContent).toBe('Copied');
  });

  it('renders nothing without an error', () => {
    const { container } = render(<ErrorBox error={null} />);
    expect(container.childElementCount).toBe(0);
  });
});
