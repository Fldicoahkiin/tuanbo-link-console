import { useEffect, useId, useState } from 'react';
import type { LightingDocument } from '@tb/schema';
import type { CueIngredient } from './LightingCueComposer';
import { PropertyNumberInput } from './PropertyNumberInput';

export function LightingCuePreparation({ document, ingredients, onChange, cueTime, disabled }: {
  document: LightingDocument; ingredients: CueIngredient[]; onChange: (values: CueIngredient[]) => void; cueTime: number; disabled: boolean;
}): JSX.Element {
  const id = useId();
  const enabled = ingredients.filter(entry => entry.preparation);
  const leadMs = Math.max(0, ...enabled.map(entry => entry.preparation?.leadMs ?? 0));
  const update = (index: number, preparation: CueIngredient['preparation']): void => onChange(ingredients.map((entry, i) => {
    if (i !== index) return entry;
    const rest = { ...entry }; delete rest.preparation;
    return preparation ? { ...rest, preparation } : rest;
  }));
  return <details className="cue-preparation">
    <summary><span>埋步</span><small>{enabled.length ? `提前 ${leadMs / 1000} 秒 · ${enabled.length} 个准备 Cue` : '未启用'}</small></summary>
    <div className="cue-preparation-body">
      <p>准备 Cue 需要在控台上存成灭灯状态。测试埋步时，请从准备时间之前开始播放。</p>
      {ingredients.map((entry, index) => {
        const choices = new Map<string, string>();
        for (const binding of document.ma2Bindings ?? []) for (const cue of binding.cueCatalog?.find(value => value.sequence === entry.sequence)?.cues ?? []) choices.set(String(Number(cue.number)), cue.name ?? '');
        for (const template of document.templates) {
          const stamp = template.track.cueStamp;
          if (stamp?.mode === 'fixed' && stamp.sequence === entry.sequence) choices.set(String(Number(stamp.cue)), template.name);
        }
        choices.delete(String(Number(entry.cue)));
        return <PreparationRow key={index} entry={entry} index={index} id={id} choices={choices} cueTime={cueTime} disabled={disabled} onChange={preparation => update(index, preparation)} />;
      })}
      {enabled.length ? <output className={cueTime < leadMs ? 'cue-preparation-invalid' : ''}>{cueTime < leadMs ? '准备时间早于节目开始，请缩短提前时间。' : `${((cueTime - leadMs) / 1000).toFixed(3)} 秒开始准备 → ${(cueTime / 1000).toFixed(3)} 秒正式亮灯`}</output> : null}
    </div>
  </details>;
}


function PreparationRow({ entry, index, id, choices, cueTime, disabled, onChange }: {
  entry: CueIngredient; index: number; id: string; choices: Map<string, string>; cueTime: number; disabled: boolean;
  onChange: (preparation: CueIngredient['preparation']) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(entry.preparation);
  useEffect(() => { setDraft(entry.preparation); }, [entry.preparation]);
  const issue = !draft ? '' : !/^\d{1,4}(?:\.\d{1,3})?$/.test(draft.cue) || Number(draft.cue) <= 0 || Number(draft.cue) === Number(entry.cue)
    ? '填写一个和正式 Cue 不同的准备编号后生效。' : draft.leadMs > cueTime ? '准备时间早于节目开始，请缩短提前时间。' : '';
  const commit = (value: CueIngredient['preparation']): void => {
    setDraft(value);
    if (value && (!/^\d{1,4}(?:\.\d{1,3})?$/.test(value.cue) || Number(value.cue) <= 0 || Number(value.cue) === Number(entry.cue) || value.leadMs > cueTime)) return;
    onChange(value);
  };
  return <div className="cue-preparation-row">
    <label className="cue-preparation-toggle"><input type="checkbox" aria-label={`素材 ${index + 1} 启用埋步`} checked={Boolean(draft)} disabled={disabled} onChange={event => commit(event.target.checked ? { cue: '', leadMs: 1500 } : undefined)} /><span>{entry.name}<small>序列 {entry.sequence} · 正式 Cue {entry.cue}</small></span></label>
    {draft ? <>
      <label>准备 Cue<input aria-label={`素材 ${index + 1} 准备 Cue`} placeholder="选择或输入编号" list={`${id}-${index}`} value={draft.cue} disabled={disabled} onChange={event => setDraft({ ...draft, cue: event.target.value })} onBlur={() => commit(draft)} /><datalist id={`${id}-${index}`}>{[...choices].map(([cue, name]) => <option value={cue} key={cue}>{name || `Cue ${cue}`}</option>)}</datalist></label>
      <label>提前（秒）<PropertyNumberInput label={`素材 ${index + 1} 埋步提前秒数`} value={draft.leadMs / 1000} min={0.1} max={10} step={0.1} disabled={disabled} onCommit={value => commit({ ...draft, leadMs: Math.round(value * 1000) })} /></label>
      {issue ? <small role="status">{issue}</small> : null}
    </> : null}
  </div>;
}
