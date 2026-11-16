/** The slice of a Monaco editor that `bindEditorKeys` needs (kept small so tests can fake it). */
export interface KeyBindableEditor {
  addAction(action: { id: string; label: string; keybindings: number[]; run: () => void }): { dispose(): void };
}

export interface EditorKey {
  id: string;
  label: string;
  keybinding: number;
  run: () => void;
}

/**
 * Binds shortcuts to ONE editor. Monaco's `addCommand` registers keybindings
 * globally and never unregisters them, so after an editor is disposed (e.g. on
 * switching database) its handler keeps firing against a dead editor whose
 * model is null. `addAction` is scoped to the editor and disposed with it.
 */
export function bindEditorKeys(ed: KeyBindableEditor, keys: EditorKey[]): { dispose(): void } {
  const handles = keys.map((k) => ed.addAction({ id: k.id, label: k.label, keybindings: [k.keybinding], run: () => k.run() }));
  return { dispose: () => handles.forEach((h) => h.dispose()) };
}
