import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { ColumnsPicker, JumpPalette, jumpItems, type ToolColumn } from './GridTools';

afterEach(cleanup);

const cols: ToolColumn[] = [
  { name: 'id', type: 'long', hidden: false },
  { name: 'status_id', type: 'long', hidden: false },
  { name: 'customer_id', type: 'long', hidden: true },
];

describe('jumpItems', () => {
  it('offers a row for a number in range, matching columns best first, then a value search', () => {
    expect(jumpItems('2', cols, 10).map((i) => i.kind)).toEqual(['row', 'value']);
    expect(jumpItems('99', cols, 10).map((i) => i.kind)).toEqual(['value']);
    const ids = jumpItems('id', cols, 10).flatMap((i) => (i.kind === 'column' ? [i.col.name] : []));
    expect(ids).toEqual(['id', 'status_id', 'customer_id']);
    expect(jumpItems('', cols, 10)).toHaveLength(3);
  });
});

describe('JumpPalette', () => {
  it('jumps to a hidden column, a row, or finds a value', () => {
    const onColumn = vi.fn();
    const onRow = vi.fn();
    const onFind = vi.fn(() => false);
    const onClose = vi.fn();
    render(<JumpPalette columns={cols} rowCount={50} onColumn={onColumn} onRow={onRow} onFind={onFind} onClose={onClose} />);
    expect(screen.getByText('Hidden')).toBeTruthy();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'cust' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onColumn).toHaveBeenCalledWith('customer_id');
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRow).toHaveBeenCalledWith(7);
    fireEvent.change(input, { target: { value: 'zzz' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onFind).toHaveBeenCalledWith('zzz');
    expect(screen.getByText('No match')).toBeTruthy();
  });
});

describe('ColumnsPicker', () => {
  it('applies the chosen columns; Clear means all', () => {
    const onApply = vi.fn();
    render(<ColumnsPicker columns={cols} onApply={onApply} onClose={() => {}} />);
    expect(screen.getAllByRole('listitem').map((l) => l.textContent)).toEqual(['id×', 'status_id×']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a column' }), { target: { value: 'customer_id' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove id' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenLastCalledWith(['status_id', 'customer_id']);
    cleanup();
    render(<ColumnsPicker columns={cols} onApply={onApply} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenLastCalledWith([]);
  });
});
