import { useState } from 'react';
import { lightingDocumentSchema, type LightingDocument } from '@tb/schema';

export function LightingEffectCombination({ document, ids, onChange, onClose }: { document: LightingDocument; ids: string[]; onChange: (document: LightingDocument, label: string) => void; onClose: () => void }): JSX.Element {
  const effects = document.templates.filter(effect => ids.includes(effect.id));
  const [name, setName] = useState('');
  const [delays, setDelays] = useState<Record<string, number>>({});
  const [error, setError] = useState('');
  const save = (): void => {
    try {
      const first = effects[0];
      if (!first || !name.trim()) throw new Error('请填写组合名称');
      const members = effects.flatMap(effect => {
        const binding = effect.track.cueStamp;
        if (binding?.mode !== 'fixed') throw new Error('效果尚未绑定 Cue');
        return effect.members?.map(member => ({ ...member, delayMs: member.delayMs + (delays[effect.id] ?? 0) })) ?? [{ name: effect.name, sequence: binding.sequence, cue: binding.cue, executor: binding.executor, delayMs: delays[effect.id] ?? 0 }];
      });
      if (new Set(members.map(member => `${member.executor || `sequence:${member.sequence}`}/${member.delayMs}`)).size !== members.length) throw new Error('同一序列或执行器不能在同一时刻调用多个 Cue，请调整延迟');
      if (!members.some(member => member.delayMs === 0)) throw new Error('至少一个效果应在 0 秒开始');
      onChange(lightingDocumentSchema.parse({ ...document, templates: [...document.templates, { id: crypto.randomUUID(), name: name.trim(), track: { ...first.track, id: crypto.randomUUID(), name: name.trim() }, categories: [...new Set(effects.flatMap(effect => effect.categories ?? []))], members }] }), '保存组合效果');
      onClose();
    } catch (cause) { setError(String(cause)); }
  };
  return <div className="effect-binding-backdrop"><form className="effect-binding-form" onSubmit={event => { event.preventDefault(); save(); }}><label>名称<input required value={name} onChange={event => setName(event.target.value)} /></label><p>默认同时触发；延迟单位为秒。</p>{effects.map(effect => <label key={effect.id}>{effect.name}<input aria-label={`${effect.name} 延迟秒`} type="number" min="0" step="0.01" value={(delays[effect.id] ?? 0) / 1000} onChange={event => setDelays({ ...delays, [effect.id]: Number(event.target.value) * 1000 })} /></label>)}{error ? <p role="alert">{error}</p> : null}<footer><button type="button" onClick={onClose}>取消</button><button>保存组合</button></footer></form></div>;
}
