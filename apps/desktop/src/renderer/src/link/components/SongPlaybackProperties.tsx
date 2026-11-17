import { useState, type InputHTMLAttributes } from 'react';
import { PropertyNumberInput } from './PropertyNumberInput';
import { defaultItemPlayback, formatMtcStart, parseMtcStart, programTimeOrigin, savedSongVolume, setItemPlaybackCommand, setItemVolumeCommand } from '@tb/core/link';
import type { RundownItem } from '@tb/schema';
import { chordLabel, chordOf } from '../keys/key-chord';
import { songKeyNote, songKeyProblem } from '../keys/key-settings';
import { useDocumentStore } from '../stores/document-store';
import { currentKeymap, useKeyNames } from '../stores/shortcut-store';
import { Disclosure, Select, TextInput, WithUnit } from '../ui';
import { ownKeys } from '../keys/key-owner';
import { useFieldDraft } from './useFieldDraft';
import { useShowGate } from '../stores/show-state-store';

type Playback = NonNullable<RundownItem['playback']>;
type Notify = (message: string, tone?: 'error' | 'info') => void;

/** A song's playback settings as saved, and the edits that save them in the project. */
function useSongPlayback(item: RundownItem, notify: Notify) {
  const frameRate = useDocumentStore((state) => state.project?.timebase.frameRate ?? '30');
  let originMs = 0, originError: string | null = null;
  try { originMs = programTimeOrigin(item); }
  catch (error) { originError = error instanceof Error ? error.message : String(error); }
  // A song without its own end action follows the player's 播放方式.
  const value: Playback = item.playback ?? defaultItemPlayback(item, originMs);
  const offset = originError ? item.p1Media?.midiStartTime ?? '' : formatMtcStart(value.mtcOffsetMs, frameRate);
  const commit = (next: Playback): boolean => {
    try { useDocumentStore.getState().execute(setItemPlaybackCommand(item.id, next)); return true; }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); return false; }
  };
  const save = (patch: Partial<Playback>): boolean => {
    if (originError && patch.mtcOffsetMs === undefined) { notify(originError, 'error'); return false; }
    if (Object.entries(patch).every(([key, next]) => value[key as keyof Playback] === next)) return true;
    return commit({ ...value, ...patch });
  };
  return { frameRate, originError, value, offset, commit, save };
}

/**
 * The song's MTC start (时:分:秒), saved in the project on Enter or when focus leaves; Escape puts
 * the saved value back. Used by the song properties and the 时间码 settings page.
 */
type MtcStartInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'width' | 'defaultValue' | 'value' | 'onChange' | 'onBlur' | 'onKeyDown' | 'onInput'> & { item: RundownItem; notify: Notify };
export function SongMtcStartInput(props: MtcStartInputProps): JSX.Element {
  return <SongMtcDraftInput key={props.item.id} {...props} />;
}
function SongMtcDraftInput({ item, notify, ...props }: MtcStartInputProps): JSX.Element {
  const { frameRate, originError, offset, save } = useSongPlayback(item, notify);
  const draft = useFieldDraft(offset);
  const [error, setError] = useState('');
  const gate = useShowGate('song.audio.edit', item.id);
  const waiting = gate.kind === 'wait' ? gate.message : props.disabled ? '请停止播放后修改起始时间。' : null;
  return <><TextInput {...props} disabled={Boolean(props.disabled || waiting)} title={waiting ?? '时:分:秒，例如 00:20:00；回车保存，Esc 取消'} aria-invalid={Boolean(originError || error)} value={draft.shown} placeholder="00:00:00" spellCheck={false} {...ownKeys('Escape')}
    onChange={event => { draft.type(event.currentTarget.value); setError(''); }}
    onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key !== 'Enter' && event.key !== 'Escape') return;
      event.preventDefault();
      if (event.key === 'Escape') { event.currentTarget.value = offset; draft.end(); setError(''); }
      event.currentTarget.blur();
    }}
    onBlur={(event) => {
      const input = event.currentTarget;
      if (input.value === offset) { draft.end(); return; }
      try {
        if (save({ mtcOffsetMs: parseMtcStart(input.value, frameRate) })) { draft.end(); setError(''); }
        else setError('起始时间没有保存，请停止播放后再按回车保存。');
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    }} />{error ? <small role="alert">{error}</small> : waiting ? <small role="status">{waiting}</small> : null}</>;
}

/**
 * The song's own volume (2026-11-09, docs/SONG_VOLUME.md), the same value as the player-bar slider. It stays editable
 * while 联动台播放 holds the song, and the song in the player plays at it at once (the project's version, S10).
 */
export function SongVolumeField({ item, notify, disabled = false }: { item: RundownItem; notify: Notify; disabled?: boolean }): JSX.Element {
  const commit = (volume: number): boolean => {
    try { useDocumentStore.getState().execute(setItemVolumeCommand(item.id, volume, crypto.randomUUID())); return true; }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); return false; }
  };
  return <label className="song-volume-field" title="仅影响这首音频，随工程保存。0% 为静音，100% 为原始音量。"><span>音量<small>只用于联动台播放；P1 跟随时由 P1 控制音量</small></span><WithUnit unit="%"><PropertyNumberInput className="ui-input" label="歌曲音量" min={0} max={100} disabled={disabled} value={savedSongVolume(item)} onCommit={commit} /></WithUnit></label>;
}

/** `withVolume` false: the volume is shown apart (SongVolumeField), outside a fieldset locked while a song plays. */
export function SongPlaybackProperties({ item, notify, collapseAdvanced = false, withVolume = true }: { collapseAdvanced?: boolean; item: RundownItem; notify: Notify; withVolume?: boolean }): JSX.Element {
  const { originError, value, commit, save } = useSongPlayback(item, notify);
  const timecode = <label className="mtc-offset-field" title={originError ?? `歌曲播放位置 + MTC 起始时间 = 输出时间码。${item.p1Media ? `P1 导入原值：${item.p1Media.midiStartTime}（秒或时:分:秒）。` : ''}修改后下次播放生效。`}><span>MTC 起始时间<small>时:分:秒 · 回车保存，Esc 取消</small></span><SongMtcStartInput item={item} notify={notify} className="ui-input" aria-label="MTC 起始时间（时:分:秒）" /></label>;
  // What the shortcut takes away or does not get (Space is also play and pause, a page's own key comes first there),
  // said under the field as long as it is set (keys/key-settings.ts `songKeyNote`, K10).
  useKeyNames();
  const shortcutNote = value.shortcut ? songKeyNote(currentKeymap(), value.shortcut) : null;
  const advanced = <>
    <label className="song-shortcut-field"><span>快捷键{shortcutNote ? <small>{shortcutNote}</small> : null}</span><TextInput aria-label="歌曲快捷键" {...ownKeys('*')} value={value.shortcut ? chordLabel(value.shortcut) : ''} readOnly placeholder="未设置" onKeyDown={(event) => {
      if (event.key === 'Tab') return;
      event.preventDefault();
      if (event.key === 'Backspace' || event.key === 'Delete') { save({ shortcut: '' }); return; }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
      // The stop keys, Windows' own and the project's keys are refused; Space and a key of the editor or the lighting
      // workbench only get the note under the field (keys/key-settings.ts, K8, K10).
      const shortcut = chordOf(event, { meta: false });
      const problem = songKeyProblem(currentKeymap(), shortcut);
      if (problem) { notify(problem, 'error'); return; }
      save({ shortcut });
    }} /></label>
  </>;
  return <>
    {withVolume ? <SongVolumeField item={item} notify={notify} /> : null}
    <label className="song-end-action"><span>播完动作</span><Select aria-label="逐曲播完动作" value={value.endAction ?? ''} onChange={(event) => {
      const endAction = event.currentTarget.value;
      if (endAction === 'next' || endAction === 'loop' || endAction === 'pause' || endAction === 'stop') save({ endAction });
      else if (endAction === '' && value.endAction) { const { volume, startMs, endMs, mtcOffsetMs, shortcut } = value; commit({ volume, startMs, endMs, mtcOffsetMs, shortcut }); }
    }}><option value="">跟随播放方式</option><option value="next">下一首</option><option value="loop">循环</option><option value="pause">暂停在结尾</option><option value="stop">停止</option></Select></label>
    {timecode}
    <label><span>开始</span><WithUnit unit="秒"><PropertyNumberInput className="ui-input" label="开始（秒）" min={0} step={0.001} value={value.startMs / 1000} onCommit={(seconds) => save({ startMs: Math.round(seconds * 1000) })} /></WithUnit></label>
    <label><span title="填 0 使用音频原始结尾">结束</span><WithUnit unit="秒"><PropertyNumberInput className="ui-input" label="结束（秒）" min={0} step={0.001} value={value.endMs / 1000} onCommit={(seconds) => save({ endMs: Math.round(seconds * 1000) })} /></WithUnit></label>
    {collapseAdvanced ? <Disclosure className="song-advanced" title="快捷键">{advanced}</Disclosure> : advanced}
  </>;
}
