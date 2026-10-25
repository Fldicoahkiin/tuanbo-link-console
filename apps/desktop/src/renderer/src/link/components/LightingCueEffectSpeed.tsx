import { useState } from 'react';
import { Gauge } from 'lucide-react';
import { LIGHTING_EFFECT_BPM, lightingEffectBeats, type LightingDocument, type LightingEffectSpeed } from '@tb/schema';
import { LightingTempoMap, lightingEffectBpm, lightingEventTime, lightingPointEffectSpeed, setLightingEffectSpeed, songBpmAt } from '@tb/core/link';
import { PropertyNumberInput } from './PropertyNumberInput';
import '../lighting-cue-effect-speed.css';

const beatsLabel = (beats: number): string => beats < 1 ? `1/${1 / beats} 拍` : `${beats} 拍`;
const round = (value: number): number => Math.round(value * 100) / 100;

/** The speed one timeline point's step runs its effects at on the console, set for the whole point. */
export function effectSpeedView(document: LightingDocument, eventId: string): { pointId: string; atMs: number; speed: LightingEffectSpeed | undefined; bpm: number | null; songBpm: number; error: string; written: number | undefined } {
  const map = new LightingTempoMap(document.tempos);
  const all = document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.map(event => ({ event, ms: lightingEventTime(clip, event, map) }))));
  const selected = all.find(value => value.event.id === eventId)?.event;
  const pointId = selected?.effectGroupId ?? eventId;
  const members = all.filter(value => (value.event.effectGroupId ?? value.event.id) === pointId);
  const atMs = Math.min(...members.map(value => value.ms));
  const name = selected && 'label' in selected ? selected.label : '';
  const written = document.consoleSong?.points.find(point => point.id === pointId)?.effectBpm;
  const songBpm = round(songBpmAt(document, atMs));
  const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
  let speed: LightingEffectSpeed | undefined;
  try { speed = lightingPointEffectSpeed(members.map(value => value.event), name); }
  catch (cause) { return { pointId, atMs, speed: undefined, bpm: null, songBpm, error: message(cause), written }; }
  // A speed outside the console range stays visible with its error, so it can be changed.
  try { return { pointId, atMs, speed, bpm: speed ? lightingEffectBpm(document, speed, atMs) : null, songBpm, error: '', written }; }
  catch (cause) { return { pointId, atMs, speed, bpm: null, songBpm, error: message(cause), written }; }
}

export function LightingCueEffectSpeed({ document, eventId, disabled, onChange }: {
  document: LightingDocument; eventId: string; disabled: boolean; onChange: (next: LightingDocument, label: string) => void | boolean;
}): JSX.Element {
  const [error, setError] = useState('');
  const view = effectSpeedView(document, eventId);
  const apply = (speed: LightingEffectSpeed | undefined, label: string): boolean => {
    try {
      if (onChange(setLightingEffectSpeed(document, eventId, speed), label) === false) throw new Error('效果速度保存失败');
      setError(''); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
  };
  const mode = view.speed?.mode ?? 'keep';
  const summary = view.error ? '需要重新设置'
    : view.speed?.mode === 'fixed' ? `固定 ${view.bpm} BPM`
    : view.speed?.mode === 'song' ? `跟随歌曲 · ${beatsLabel(view.speed.beats)}一圈 · ${view.bpm ?? '—'} BPM`
    : '保持素材原速';
  return <details className="cue-effect-speed">
    <summary><Gauge aria-hidden /><span>效果速度</span><small data-state={view.error ? 'invalid' : mode}>{summary}</small></summary>
    <div className="cue-effect-speed-body">
      <div className="cue-effect-speed-mode" role="group" aria-label="效果速度方式">
        <button type="button" aria-pressed={mode === 'keep'} disabled={disabled || mode === 'keep' && !view.error} onClick={() => apply(undefined, '效果保持原速')}>保持原速</button>
        <button type="button" aria-pressed={mode === 'fixed'} disabled={disabled || mode === 'fixed'} onClick={() => apply({ mode: 'fixed', bpm: Math.min(LIGHTING_EFFECT_BPM.max, Math.max(LIGHTING_EFFECT_BPM.min, view.bpm ?? view.songBpm)) }, '效果固定速度')}>固定 BPM</button>
        <button type="button" aria-pressed={mode === 'song'} disabled={disabled || mode === 'song'} onClick={() => apply({ mode: 'song', beats: 1 }, '效果跟随歌曲速度')}>跟随歌曲</button>
      </div>
      {view.speed?.mode === 'fixed' ? <label className="cue-effect-speed-field">BPM
        <PropertyNumberInput label="效果速度 BPM" min={LIGHTING_EFFECT_BPM.min} max={LIGHTING_EFFECT_BPM.max} step={0.01} precision={2} value={view.speed.bpm} disabled={disabled} onCommit={bpm => apply({ mode: 'fixed', bpm }, '修改效果速度')} />
      </label> : null}
      {view.speed?.mode === 'song' ? <label className="cue-effect-speed-field">几拍一圈
        <select aria-label="效果几拍一圈" value={view.speed.beats} disabled={disabled} onChange={event => {
          const beats = lightingEffectBeats.find(value => String(value) === event.currentTarget.value);
          if (beats !== undefined) apply({ mode: 'song', beats }, '修改效果速度');
        }}>{lightingEffectBeats.map(beats => <option key={beats} value={beats}>{beatsLabel(beats)}</option>)}</select>
      </label> : null}
      {view.speed?.mode === 'song' ? <output>{view.bpm === null ? '' : `= ${view.bpm} BPM（这里的歌曲速度 ${view.songBpm} BPM）`}</output> : null}
      <small>速度只写进本曲控台序列的这一步，素材库里的原 Cue 不变；这一步里的所有效果统一成这个速度。播放仍按 MTC 触发。</small>
      {mode === 'keep' && view.written !== undefined ? <small>控台这一步上次写入的是 {view.written} BPM，软件不再改它；要回到素材原速，请重新放入素材。</small> : null}
      {view.error || error ? <p role="alert">{error || view.error}</p> : null}
    </div>
  </details>;
}
