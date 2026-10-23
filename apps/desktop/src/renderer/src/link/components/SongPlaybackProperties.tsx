import { PropertyNumberInput } from './PropertyNumberInput';
import { formatMtcOffset, parseMtcOffset, programTimeOrigin, setItemPlaybackCommand } from '@tb/core/link';
import type { RundownItem } from '@tb/schema';

type Playback = NonNullable<RundownItem['playback']>;
import { useDocumentStore } from '../stores/document-store';

export function SongPlaybackProperties({ item, notify, collapseAdvanced = false }: { collapseAdvanced?: boolean; item: RundownItem; notify: (message: string, tone?: 'error' | 'info') => void }): JSX.Element {
  const frameRate = useDocumentStore((state) => state.project?.timebase.frameRate ?? '30');
  let originMs = 0, originError: string | null = null;
  try { originMs = programTimeOrigin(item); }
  catch (error) { originError = error instanceof Error ? error.message : String(error); }
  // A song without its own end action follows the player's 播放方式.
  const value: Playback = item.playback ?? { volume: 100, startMs: 0, endMs: 0, mtcOffsetMs: originMs, shortcut: '' };
  const offset = originError ? item.p1Media?.midiStartTime ?? '' : formatMtcOffset(value.mtcOffsetMs, frameRate);
  const commit = (next: Playback): boolean => {
    try { useDocumentStore.getState().execute(setItemPlaybackCommand(item.id, next)); return true; }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); return false; }
  };
  const save = (patch: Partial<Playback>): boolean => {
    if (originError && patch.mtcOffsetMs === undefined) { notify(originError, 'error'); return false; }
    if (Object.entries(patch).every(([key, next]) => value[key as keyof Playback] === next)) return true;
    return commit({ ...value, ...patch });
  };
  const timecode = <label className="mtc-offset-field" title={originError ?? `歌曲播放位置 + MTC 起始时间 = 输出时间码。${item.p1Media ? `P1 导入原值：${item.p1Media.midiStartTime}（秒或时:分:秒）。` : ''}修改后下次播放生效。`}><span>MTC 起始时间<small>时:分:秒:帧 · {frameRate}</small></span><input key={`${item.id}:${frameRate}:${offset}`} aria-label="MTC 起始时间（时:分:秒:帧）" aria-invalid={Boolean(originError)} defaultValue={offset} placeholder="00:00:00:00" spellCheck={false}
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
      }} /></label>;
  const advanced = <>
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
    <label><span>播完动作</span><select aria-label="逐曲播完动作" value={value.endAction ?? ''} onChange={(event) => {
      const endAction = event.currentTarget.value;
      if (endAction === 'next' || endAction === 'loop' || endAction === 'pause' || endAction === 'stop') save({ endAction });
      else if (endAction === '' && value.endAction) { const { volume, startMs, endMs, mtcOffsetMs, shortcut } = value; commit({ volume, startMs, endMs, mtcOffsetMs, shortcut }); }
    }}><option value="">跟随播放方式</option><option value="next">下一首</option><option value="loop">循环</option><option value="pause">暂停在结尾</option><option value="stop">停止</option></select></label>
    {timecode}
    <label><span>开始</span><div className="property-number-unit"><PropertyNumberInput label="开始（秒）" min={0} step={0.001} value={value.startMs / 1000} onCommit={(seconds) => save({ startMs: Math.round(seconds * 1000) })} /><small>s</small></div></label>
    <label><span title="填 0 使用音频原始结尾">结束</span><div className="property-number-unit"><PropertyNumberInput label="结束（秒）" min={0} step={0.001} value={value.endMs / 1000} onCommit={(seconds) => save({ endMs: Math.round(seconds * 1000) })} /><small>s</small></div></label>
    {collapseAdvanced ? <details className="song-advanced"><summary>快捷键</summary><div>{advanced}</div></details> : advanced}
  </>;
}
