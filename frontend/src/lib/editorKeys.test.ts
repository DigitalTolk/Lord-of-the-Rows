import { describe, expect, it, vi } from 'vitest';
import { bindEditorKeys, type KeyBindableEditor } from './editorKeys';

function fakeEditor() {
  const actions: { id: string; keybindings: number[]; run: () => void; disposed: boolean }[] = [];
  const ed: KeyBindableEditor = {
    addAction: (a) => {
      const entry = { ...a, disposed: false };
      actions.push(entry);
      return { dispose: () => (entry.disposed = true) };
    },
  };
  return { ed, actions };
}

describe('bindEditorKeys', () => {
  it('registers each shortcut as an editor-scoped action that runs its handler', () => {
    const { ed, actions } = fakeEditor();
    const run = vi.fn();
    bindEditorKeys(ed, [{ id: 'dbs.run', label: 'Run', keybinding: 2051, run }]);
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe('dbs.run');
    expect(actions[0].keybindings).toEqual([2051]);
    actions[0].run();
    expect(run).toHaveBeenCalledOnce();
  });

  it('disposes every action together', () => {
    const { ed, actions } = fakeEditor();
    const h = bindEditorKeys(ed, [
      { id: 'a', label: 'A', keybinding: 1, run: () => {} },
      { id: 'b', label: 'B', keybinding: 2, run: () => {} },
    ]);
    h.dispose();
    expect(actions.every((a) => a.disposed)).toBe(true);
  });
});
