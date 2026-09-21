import { Button } from './Button';
import { PropertyNumberInput } from './PropertyNumberInput';
import { ArrowDown, ArrowUp, Play, Trash2 } from 'lucide-react';
import { moveActionCommand, removeActionCommand, replaceActionCommand } from '@tb/core/link';
import type { LinkAction } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useIntegrationStore } from '../stores/integration-store';

const ACTION_KINDS: Array<{ kind: LinkAction['kind']; label: string }> = [
  { kind: 'obs.setProgramScene', label: 'OBS · 切换场景' },
  { kind: 'obs.setSceneItemEnabled', label: 'OBS · 场景项显示' },
  { kind: 'obs.setSceneItemTransform', label: 'OBS · 画面位置与大小' },
  { kind: 'obs.setSceneItemIndex', label: 'OBS · 场景项层序' },
  { kind: 'obs.setSourceFilterEnabled', label: 'OBS · 滤镜开关' },
  { kind: 'obs.setInputMute', label: 'OBS · 输入静音' },
  { kind: 'obs.setInputVolume', label: 'OBS · 输入音量' },
  { kind: 'obs.mediaAction', label: 'OBS · 媒体来源控制' },
  { kind: 'obs.setTransition', label: 'OBS · 转场设置' },
  { kind: 'obs.saveSourceScreenshot', label: 'OBS · 来源截图' },
  { kind: 'midi.noteOn', label: 'MIDI · 音符开始' },
  { kind: 'midi.noteOff', label: 'MIDI · 音符结束' },
  { kind: 'midi.controlChange', label: 'MIDI · 控制值（CC）' },
  { kind: 'midi.programChange', label: 'MIDI · 切换音色' },
  { kind: 'midi.showControl', label: 'MIDI · 演出控制（MSC）' }
];

type Props = {
  itemId: string;
  cueId: string;
  action: LinkAction;
  index: number;
  actionCount: number;
  onTest: (action: LinkAction) => Promise<void>;
};

export function ActionEditor({ itemId, cueId, action, index, actionCount, onTest }: Props): JSX.Element {
  const execute = useDocumentStore((state) => state.execute);
  const availableKinds = ACTION_KINDS.filter((option) => !option.kind.startsWith('obs.') || ['obs.setProgramScene', 'obs.setTransition', 'obs.saveSourceScreenshot'].includes(option.kind));
  const supported = availableKinds.some((option) => option.kind === action.kind);
  const replace = (next: LinkAction): void => execute(replaceActionCommand(itemId, cueId, next));
  const text = (label: string, value: string, update: (value: string) => LinkAction) => (
    <Field label={label}><input key={value} defaultValue={value} onBlur={(event) => { if (event.currentTarget.value !== value) replace(update(event.currentTarget.value)); }} /></Field>
  );
  const number = (label: string, value: number, update: (value: number) => LinkAction, options?: { min?: number; max?: number; step?: number }) => (
    <Field label={label}>
      <PropertyNumberInput label={label} value={value} precision={3} {...options} onCommit={(next) => replace(update(next))} />
    </Field>
  );

  return (
    <article className="action-card">
      <div className="action-card-header">
        {actionCount > 1 ? <span className="action-order">{String(index + 1).padStart(2, '0')}</span> : null}
        <select aria-label="动作类型" value={action.kind} onChange={(event) => replace(changeActionKind(action, event.currentTarget.value as LinkAction['kind']))}>
          {!supported ? <option value={action.kind} disabled>旧来源动作 · 请改为切换场景</option> : null}
          {availableKinds.map((option) => <option value={option.kind} key={option.kind}>{option.label}</option>)}
        </select>
        <input className="action-name" aria-label="动作名称" title="动作名称" key={action.label} defaultValue={action.label} onBlur={(event) => { if (event.currentTarget.value !== action.label) replace({ ...action, label: event.currentTarget.value }); }} />
        <div className="action-tools">
          {actionCount > 1 ? <><Button className="icon-button" disabled={index === 0} onClick={() => execute(moveActionCommand(itemId, cueId, action.id, index - 1))} title="上移"><ArrowUp /></Button>
          <Button className="icon-button" disabled={index === actionCount - 1} onClick={() => execute(moveActionCommand(itemId, cueId, action.id, index + 1))} title="下移"><ArrowDown /></Button></> : null}
          <Button className="icon-button" disabled={!supported} onClick={() => void onTest(action)} title="单步测试"><Play /></Button>
          <Button className="icon-button danger" onClick={() => execute(removeActionCommand(itemId, cueId, action.id))} title="删除"><Trash2 /></Button>
        </div>
      </div>
      <div className="form-grid compact">
        {renderActionFields(action, replace, text, number)}
      </div>
    </article>
  );
}


function renderActionFields(
  action: LinkAction,
  replace: (action: LinkAction) => void,
  text: (label: string, value: string, update: (value: string) => LinkAction) => JSX.Element,
  number: (label: string, value: number, update: (value: number) => LinkAction, options?: { min?: number; max?: number; step?: number }) => JSX.Element
): JSX.Element {
  switch (action.kind) {
    case 'obs.setProgramScene':
      return <><SceneField action={action} replace={replace} /><SceneTransitionFields action={action} replace={replace} /></>;
    case 'obs.setSceneItemEnabled':
      return <>{text('场景', action.sceneName, (value) => ({ ...action, sceneName: value }))}{text('来源', action.sourceName, (value) => ({ ...action, sourceName: value }))}<BooleanField label="显示" value={action.enabled} onChange={(enabled) => replace({ ...action, enabled })} /></>;
    case 'obs.setSceneItemTransform':
      return <>
        {text('场景', action.sceneName, (value) => ({ ...action, sceneName: value }))}
        {text('来源', action.sourceName, (value) => ({ ...action, sourceName: value }))}
        {number('X', action.transform.positionX, (value) => ({ ...action, transform: { ...action.transform, positionX: value } }))}
        {number('Y', action.transform.positionY, (value) => ({ ...action, transform: { ...action.transform, positionY: value } }))}
        {number('横向缩放', action.transform.scaleX, (value) => ({ ...action, transform: { ...action.transform, scaleX: value } }), { step: 0.01 })}
        {number('纵向缩放', action.transform.scaleY, (value) => ({ ...action, transform: { ...action.transform, scaleY: value } }), { step: 0.01 })}
        {number('旋转', action.transform.rotation, (value) => ({ ...action, transform: { ...action.transform, rotation: value } }))}
        {number('上裁剪', action.transform.cropTop, (value) => ({ ...action, transform: { ...action.transform, cropTop: value } }), { min: 0 })}
        {number('右裁剪', action.transform.cropRight, (value) => ({ ...action, transform: { ...action.transform, cropRight: value } }), { min: 0 })}
        {number('下裁剪', action.transform.cropBottom, (value) => ({ ...action, transform: { ...action.transform, cropBottom: value } }), { min: 0 })}
        {number('左裁剪', action.transform.cropLeft, (value) => ({ ...action, transform: { ...action.transform, cropLeft: value } }), { min: 0 })}
      </>;
    case 'obs.setSceneItemIndex':
      return <>{text('场景', action.sceneName, (value) => ({ ...action, sceneName: value }))}{text('来源', action.sourceName, (value) => ({ ...action, sourceName: value }))}{number('层序', action.sceneItemIndex, (value) => ({ ...action, sceneItemIndex: value }), { min: 0 })}</>;
    case 'obs.setSourceFilterEnabled':
      return <>{text('来源', action.sourceName, (value) => ({ ...action, sourceName: value }))}{text('滤镜', action.filterName, (value) => ({ ...action, filterName: value }))}<BooleanField label="启用" value={action.enabled} onChange={(enabled) => replace({ ...action, enabled })} /></>;
    case 'obs.setInputMute':
      return <>{text('输入', action.inputName, (value) => ({ ...action, inputName: value }))}<BooleanField label="静音" value={action.muted} onChange={(muted) => replace({ ...action, muted })} /></>;
    case 'obs.setInputVolume':
      return <>{text('输入', action.inputName, (value) => ({ ...action, inputName: value }))}{number('音量 dB', action.volumeDb, (value) => ({ ...action, volumeDb: value }), { min: -100, max: 26, step: 0.1 })}</>;
    case 'obs.mediaAction':
      return <>{text('媒体输入', action.inputName, (value) => ({ ...action, inputName: value }))}<Field label="操作"><select value={action.action} onChange={(event) => replace({ ...action, action: event.currentTarget.value as typeof action.action })}>{Object.entries({ restart: '重新播放', start: '播放', pause: '暂停', stop: '停止', next: '下一个', previous: '上一个' }).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field></>;
    case 'obs.setTransition':
      return <>{text('转场', action.transitionName, (value) => ({ ...action, transitionName: value }))}{number('时长 ms', action.durationMs, (value) => ({ ...action, durationMs: value }), { min: 0, max: 20_000 })}</>;
    case 'obs.saveSourceScreenshot':
      return <>{text('来源', action.sourceName, (value) => ({ ...action, sourceName: value }))}{text('文件名', action.fileName, (value) => ({ ...action, fileName: value }))}</>;
    case 'midi.noteOn':
    case 'midi.noteOff':
      return <>{text('端口档案', action.portProfileId, (value) => ({ ...action, portProfileId: value }))}{number('通道', action.channel, (value) => ({ ...action, channel: value }), { min: 1, max: 16 })}{number('音符', action.note, (value) => ({ ...action, note: value }), { min: 0, max: 127 })}{number('力度', action.velocity, (value) => ({ ...action, velocity: value }), { min: action.kind === 'midi.noteOn' ? 1 : 0, max: 127 })}</>;
    case 'midi.controlChange':
      return <>{text('端口档案', action.portProfileId, (value) => ({ ...action, portProfileId: value }))}{number('通道', action.channel, (value) => ({ ...action, channel: value }), { min: 1, max: 16 })}{number('控制器', action.controller, (value) => ({ ...action, controller: value }), { min: 0, max: 127 })}{number('值', action.value, (value) => ({ ...action, value }), { min: 0, max: 127 })}</>;
    case 'midi.programChange':
      return <>{text('端口档案', action.portProfileId, (value) => ({ ...action, portProfileId: value }))}{number('通道', action.channel, (value) => ({ ...action, channel: value }), { min: 1, max: 16 })}{number('音色编号', action.program, (value) => ({ ...action, program: value }), { min: 0, max: 127 })}</>;
    case 'midi.showControl':
      return <>{text('端口档案', action.portProfileId, (value) => ({ ...action, portProfileId: value }))}{number('设备编号', action.deviceId, (value) => ({ ...action, deviceId: value }), { min: 0, max: 127 })}{number('命令格式', action.commandFormat, (value) => ({ ...action, commandFormat: value }), { min: 0, max: 127 })}<Field label="命令"><select value={action.command} onChange={(event) => replace({ ...action, command: event.currentTarget.value as typeof action.command })}>{Object.entries({ go: '执行（Go）', stop: '停止', resume: '继续', load: '预载' }).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>{text('Cue 编号', action.cueNumber ?? '', (value) => ({ ...action, cueNumber: value || undefined }))}{text('Cue 列表', action.cueList ?? '', (value) => ({ ...action, cueList: value || undefined }))}{text('Cue 路径', action.cuePath ?? '', (value) => ({ ...action, cuePath: value || undefined }))}</>;
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function SceneTransitionFields({ action, replace }: { action: Extract<LinkAction, { kind: 'obs.setProgramScene' }>; replace: (action: LinkAction) => void }): JSX.Element {
  const transitions = useIntegrationStore((state) => state.inventory?.transitions) ?? [];
  const selected = action.transition;
  return <>
    <Field label="OBS 转场"><select aria-label="Cue OBS 转场" value={selected?.name ?? ''} onChange={(event) => {
      const name = event.currentTarget.value;
      if (name) replace({ ...action, transition: { name, durationMs: selected?.durationMs ?? 300 } });
      else { const remaining = { ...action }; delete remaining.transition; replace(remaining); }
    }}><option value="">沿用 OBS 当前转场</option>{[...new Set([...transitions, ...(selected ? [selected.name] : [])])].map((name) => <option key={name} value={name}>{name}{transitions.includes(name) ? '' : '（未检测到）'}</option>)}</select></Field>
    {selected ? <Field label="过渡时长（毫秒）"><PropertyNumberInput label="Cue 过渡时长（毫秒）" min={50} max={20000} value={selected.durationMs} onCommit={(durationMs) => replace({ ...action, transition: { ...selected, durationMs } })} /><small>切换和固定时长转场使用 OBS 自身时长。</small></Field> : null}
  </>;
}

function SceneField({ action, replace }: { action: Extract<LinkAction, { kind: 'obs.setProgramScene' }>; replace: (action: LinkAction) => void }): JSX.Element {
  const scenes = useIntegrationStore((state) => state.inventory?.scenes) ?? [];
  return <Field label="场景"><select value={action.sceneName} onChange={(event) => replace({ ...action, sceneName: event.currentTarget.value, label: `切换场景 · ${event.currentTarget.value}` })}>{[...new Set([action.sceneName, ...scenes])].map((name) => <option key={name} value={name}>{name}</option>)}</select></Field>;
}

function BooleanField({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }): JSX.Element {
  return <label className="check-field"><input type="checkbox" checked={value} onChange={(event) => onChange(event.currentTarget.checked)} /><span>{label}</span></label>;
}

export function defaultAction(kind: LinkAction['kind'], id: string = crypto.randomUUID()): LinkAction {
  const base = { id, label: ACTION_KINDS.find((item) => item.kind === kind)?.label ?? kind };
  switch (kind) {
    case 'obs.setProgramScene': return { ...base, kind, sceneName: 'Program' };
    case 'obs.setSceneItemEnabled': return { ...base, kind, sceneName: 'Program', sourceName: 'Source', enabled: true };
    case 'obs.setSceneItemTransform': return { ...base, kind, sceneName: 'Program', sourceName: 'Source', transform: { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, rotation: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 } };
    case 'obs.setSceneItemIndex': return { ...base, kind, sceneName: 'Program', sourceName: 'Source', sceneItemIndex: 0 };
    case 'obs.setSourceFilterEnabled': return { ...base, kind, sourceName: 'Source', filterName: 'Filter', enabled: true };
    case 'obs.setInputMute': return { ...base, kind, inputName: 'Input', muted: true };
    case 'obs.setInputVolume': return { ...base, kind, inputName: 'Input', volumeDb: 0 };
    case 'obs.mediaAction': return { ...base, kind, inputName: 'Media', action: 'restart' };
    case 'obs.setTransition': return { ...base, kind, transitionName: 'Cut', durationMs: 0 };
    case 'obs.saveSourceScreenshot': return { ...base, kind, sourceName: 'Source', fileName: 'screenshot.png' };
    case 'midi.noteOn': return { ...base, kind, portProfileId: 'p1-output', channel: 1, note: 60, velocity: 100 };
    case 'midi.noteOff': return { ...base, kind, portProfileId: 'p1-output', channel: 1, note: 60, velocity: 0 };
    case 'midi.controlChange': return { ...base, kind, portProfileId: 'p1-output', channel: 1, controller: 1, value: 127 };
    case 'midi.programChange': return { ...base, kind, portProfileId: 'p1-output', channel: 1, program: 0 };
    case 'midi.showControl': return { ...base, kind, portProfileId: 'p1-output', deviceId: 0x7f, commandFormat: 0x7f, command: 'go', cueNumber: '1' };
  }
}

export function defaultLightingAction(id: string = crypto.randomUUID()): LinkAction {
  return {
    id,
    label: '灯光 · MSC GO',
    kind: 'midi.showControl',
    portProfileId: 'lighting-output',
    deviceId: 0x7f,
    commandFormat: 0x01,
    command: 'go',
    cueNumber: '1'
  };
}

function changeActionKind(action: LinkAction, kind: LinkAction['kind']): LinkAction {
  const next = defaultAction(kind, action.id);
  if (next.kind === 'obs.setProgramScene' && 'sceneName' in action) return { ...next, sceneName: action.sceneName };
  if ('portProfileId' in action && 'portProfileId' in next) {
    return { ...next, portProfileId: action.portProfileId };
  }
  return next;
}
