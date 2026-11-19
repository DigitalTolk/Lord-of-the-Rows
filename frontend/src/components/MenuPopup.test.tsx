import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MenuPopup } from './ui';

// jsdom has no layout: give the menu a real size and the window a size.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.getAttribute('role') === 'menu' ? 300 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.getAttribute('role') === 'menu' ? 200 : 0;
  });
  vi.stubGlobal('innerHeight', 800);
  vi.stubGlobal('innerWidth', 1000);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const menu = (x: number, y: number) => {
  render(
    <MenuPopup x={x} y={y} onClose={() => {}} label="m">
      <button role="menuitem">A</button>
    </MenuPopup>,
  );
  return screen.getByRole('menu');
};

describe('MenuPopup placement', () => {
  it('opens at the pointer when it fits', () => {
    const m = menu(100, 100);
    expect([m.style.left, m.style.top]).toEqual(['100px', '100px']);
  });

  it('opens upward when there is no room below the pointer (whole menu visible)', () => {
    const m = menu(100, 700);
    expect(m.style.top).toBe('400px'); // 700 - 300
  });

  it('moves left when it would leave the right edge', () => {
    const m = menu(950, 100);
    expect(m.style.left).toBe('796px'); // 1000 - 200 - 4
  });

  it('scrolls when taller than the window', () => {
    vi.stubGlobal('innerHeight', 200);
    const m = menu(10, 150);
    expect(m.style.top).toBe('4px');
    expect(m.style.maxHeight).toBe('192px');
    expect(m.className).toContain('overflow-auto');
  });
});
