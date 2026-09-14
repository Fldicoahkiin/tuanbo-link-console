import { lightingEventSchema, type LightingEvent } from '@tb/schema';

export function LightingEventFields(props: { event: LightingEvent; timeLock: 'time' | 'beat'; disabled: boolean; onChange: (event: LightingEvent) => void }): JSX.Element {
  const { event, disabled, onChange } = props;
  const number = (label: string, value: number, min: number, max: number, update: (value: number) => LightingEvent, step = 1): JSX.Element => <label className="property-row"><span>{label}</span><input aria-label={label} type="number" min={min} max={max} step={step} key={`${event.id}:${label}:${value}`} defaultValue={value} disabled={disabled} onInput={(input) => input.currentTarget.setCustomValidity('')} onBlur={(input) => {
    const field = input.currentTarget;
    const next = field.valueAsNumber;
    if (next === value) return;
    const candidate = update(next);
    if (!field.value.trim() || !field.validity.valid || !lightingEventSchema.safeParse(candidate).success) {
      field.value = String(value); field.setCustomValidity(`请输入 ${min} 至 ${max} 范围内的有效数值`); field.reportValidity(); return;
    }
    onChange(candidate);
  }} /></label>;
  const text = (label: string, value: string, update: (value: string) => LightingEvent): JSX.Element => <label className="property-row"><span>{label}</span><input aria-label={label} key={`${event.id}:${label}:${value}`} defaultValue={value} disabled={disabled} onInput={(input) => input.currentTarget.setCustomValidity('')} onBlur={(input) => {
    const next = input.currentTarget.value.trim();
    if (next === value) return;
    const candidate = update(next);
    if (!lightingEventSchema.safeParse(candidate).success || (label === '执行器' && !/^[1-9]\d*\.[1-9]\d*$/.test(next))) {
      input.currentTarget.value = value; input.currentTarget.setCustomValidity(label === '执行器' ? '请输入页.编号，例如 1.5' : '请输入 Cue 编号，例如 1 或 1.25'); input.currentTarget.reportValidity(); return;
    }
    onChange(candidate);
  }} /></label>;
  const durationScale = props.timeLock === 'time' ? 1000 : 1;
  switch (event.kind) {
    case 'raw': return <span title={event.bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ')}>{event.label}</span>;
    case 'note': return <div className="lighting-event-fields">{number('音符', event.note, 0, 127, (note) => ({ ...event, note }))}{number('力度', event.velocity, 1, 127, (velocity) => ({ ...event, velocity }))}{number(`持续（${props.timeLock === 'time' ? '秒' : '拍'}）`, event.duration / durationScale, 0.001, 86400000 / durationScale, (duration) => ({ ...event, duration: duration * durationScale }), 0.001)}</div>;
    case 'cc': return <div className="lighting-event-fields">{number('CC', event.controller, 0, 127, (controller) => ({ ...event, controller }))}{number('值', event.value, 0, 127, (value) => ({ ...event, value }))}</div>;
    case 'program': return number('程序编号', event.program, 0, 127, (program) => ({ ...event, program }));
    case 'ma2-fader': return <div className="lighting-event-fields">{number('主推杆 %', Number((event.level * 100).toFixed(10)), 0, 100, (percent) => ({ ...event, level: Number((percent / 100).toFixed(3)) }), 0.1)}{text('执行器', event.executor, (executor) => ({ ...event, executor }))}</div>;
    case 'point': return <div className="lighting-event-fields">{number('值', event.value, 0, 127, (value) => ({ ...event, value }), 0.001)}<select aria-label="曲线形状" value={event.shape} disabled={disabled} onChange={(input) => onChange({ ...event, controlValues: undefined, shape: input.target.value as typeof event.shape })}><option value="hold">保持</option><option value="linear">线性</option><option value="smooth">平滑</option></select></div>;
    case 'ma2': return <div className="lighting-event-fields"><label>名称<input title="Cue 名称" aria-label="Cue 名称" value={event.label} disabled={disabled} onChange={(input) => onChange({ ...event, label: input.target.value })} /></label>{event.action === 'goto' ? text('Cue 编号', event.cue ?? '', (cue) => ({ ...event, cue })) : null}{text('执行器', event.executor, (executor) => ({ ...event, executor }))}{event.action === 'goto' ? number('序列', event.sequence ?? 1, 1, 99999, (sequence) => ({ ...event, sequence })) : null}<label>动作<select aria-label="MA2 动作" value={event.action} disabled={disabled} onChange={(input) => onChange({ ...event, ...(input.target.value === 'goto' ? { cue: event.cue ?? '1', sequence: event.sequence ?? 1 } : {}), action: input.target.value as typeof event.action })}><option value="goto">切换到 Cue</option><option value="go">下一步</option><option value="off">关闭执行器</option></select></label></div>;
  }
}

