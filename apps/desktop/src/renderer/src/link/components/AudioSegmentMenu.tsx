import { Scissors, SlidersHorizontal, Trash2, ChevronsLeft, ChevronsRight } from 'lucide-react';
import type { AudioSegment } from '@tb/schema';
import { Menu, MenuItem, MenuSeparator } from '../ui';
import { usePlayheadMs, type EditorPlayhead } from './editor-playhead';

export function AudioSegmentMenu({ x, y, segment, playhead, disabled, onClose, onEdit, onSplit, onTrim, onRemove }: {
  x: number; y: number; segment: AudioSegment; playhead: EditorPlayhead; disabled: boolean;
  onClose: () => void; onEdit: () => void; onSplit: () => void; onTrim: (edge: 'start' | 'end') => void; onRemove: () => void;
}): JSX.Element {
  // Open for a moment: it follows the playhead every frame, as it did before (0.5.9 E2).
  const playheadMs = usePlayheadMs(playhead);
  const inside = playheadMs > segment.startMs && playheadMs < segment.startMs + segment.durationMs;
  const run = (action: () => void): void => { onClose(); action(); };
  return <Menu x={x} y={y} label="音频片段菜单" onClose={onClose}>
    <MenuItem icon={SlidersHorizontal} disabled={disabled} onSelect={() => run(onEdit)}>编辑片段</MenuItem>
    <MenuItem icon={Scissors} shortcut="S" disabled={disabled || !inside} onSelect={() => run(onSplit)}>在播放头分割</MenuItem>
    <MenuItem icon={ChevronsRight} disabled={disabled || !inside} onSelect={() => run(() => onTrim('start'))}>将开头修剪至播放头</MenuItem>
    <MenuItem icon={ChevronsLeft} disabled={disabled || !inside} onSelect={() => run(() => onTrim('end'))}>将结尾修剪至播放头</MenuItem>
    <MenuSeparator />
    <MenuItem icon={Trash2} danger shortcut="Delete" disabled={disabled} onSelect={() => run(onRemove)}>删除音频片段</MenuItem>
  </Menu>;
}
