import { PropertyNumberInput } from './PropertyNumberInput';
import { formatMtcOffset, parseMtcOffset, setItemPlaybackCommand } from '@tb/core/link';
import type { RundownItem } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';

export function SongPlaybackProperties({ item, notify, collapseAdvanced = false }: { collapseAdvanced?: boolean; item: RundownItem; notify: (message: string, tone?: 'error' | 'info') => void }): JSX.Element {
  const frameRate = useDocumentStore((state) => state.project?.timebase.frameRate ?? '30');
  const value = item.playback ?? { volume: 100, endAction: 'pause', startMs: 0, endMs: 0, mtcOffsetMs: 0, shortcut: '' };
  const offset = formatMtcOffset(value.mtcOffsetMs, frameRate);
  const save = (patch: Partial<typeof value>): boolean => {
    if (Object.entries(patch).every(([key, next]) => value[key as keyof typeof value] === next)) return true;
    try { useDocumentStore.getState().execute(setItemPlaybackCommand(item.id, { ...value, ...patch })); return true; }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); return false; }
  };
  const advanced = <>
    <label className="mtc-offset-field" title={`时:分:秒:帧 · ${frameRate} fps；歌曲播放位置加上此偏移，作为输出给控台的时间码`}><span>MTC 偏移<small>时:分:秒:帧 · {frameRate}</small></span><input key={`${item.id}:${frameRate}:${offset}`} aria-label="MTC 偏移（时:分:秒:帧）" defaultValue={offset} placeholder="00:00:00:00" spellCheck={false}
      onInput={(event) => event.currentTarget.setCustomValidity('')}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') { event.currentTarget.value = offset; event.currentTarget.setCustomValidity(''); }
        event.currentTarget.blur();
      }}
      onBlur={(event) => {
        const input = event.currentTarget;
        if (input.value === offset) return;
        try { if (!save({ mtcOffsetMs: parseMtcOffset(input.value, frameRate) })) input.value = offset; }
        catch (error) { const message = error instanceof Error ? error.message : String(error); input.value = offset; input.setCustomValidity(message); input.reportValidity(); notify(message, 'error'); }
      }} /></label>
    <label><span>快捷键</span><input aria-label="歌曲快捷键" value={value.shortcut} readOnly placeholder="未设置" onKeyDown={(event) => {
      if (event.key === 'Tab') return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Backspace' || event.key === 'Delete') { save({ shortcut: '' }); return; }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
      save({ shortcut: [...(event.ctrlKey ? ['Ctrl'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), event.code].join('+') });
    }} /></label>
  </>;
  return <>
    <label title="仅影响这首音频，随工程保存。0% 为静音，100% 为原始音量。"><span>音量</span><div className="property-number-unit"><PropertyNumberInput label="歌曲音量" min={0} max={100} value={value.volume} onCommit={(volume) => save({ volume })} /><small>%</small></div></label>
    <label><span>播完动作</span><select aria-label="逐曲播完动作" value={value.endAction} onChange={(event) => { const endAction = event.currentTarget.value; if (endAction === 'next' || endAction === 'loop' || endAction === 'pause' || endAction === 'stop') save({ endAction }); }}><option value="next">下一首</option><option value="loop">循环</option><option value="pause">暂停在结尾</option><option value="stop">停止</option></select></label>
    <label><span>开始</span><div className="property-number-unit"><PropertyNumberInput label="开始（秒）" min={0} step={0.001} value={value.startMs / 1000} onCommit={(seconds) => save({ startMs: Math.round(seconds * 1000) })} /><small>s</small></div></label>
    <label><span title="填 0 使用音频原始结尾">结束</span><div className="property-number-unit"><PropertyNumberInput label="结束（秒）" min={0} step={0.001} value={value.endMs / 1000} onCommit={(seconds) => save({ endMs: Math.round(seconds * 1000) })} /><small>s</small></div></label>
    {collapseAdvanced ? <details className="song-advanced"><summary>时间码与快捷键</summary><div>{advanced}</div></details> : advanced}
  </>;
}
