import { Button, IconButton, Switch, TextArea, TextInput } from '../ui';
import { PropertyNumberInput } from './PropertyNumberInput';
import { LayoutNumber } from './LayoutNumber';
import { addActionCommand, moveContentCommand, nominalFramesPerSecond, removeContentCommand, replaceActionCommand, replaceCueCommand, timecodeToMilliseconds, type LinkObsInventory } from '@tb/core/link';
import type { LinkAction, LinkCue, LinkProject } from '@tb/schema';
import { Crosshair, Maximize, Play, RotateCcw, Trash2 } from 'lucide-react';
import { useDocumentStore } from '../stores/document-store';
import { ActionEditor } from './ActionEditor';
import { resolveObsSourceSize } from './obs-source-geometry';
import { useFieldDraft } from './useFieldDraft';

export function CueInspector(props: {
  itemId: string;
  cue: LinkCue;
  frameRate: LinkProject['timebase']['frameRate'];
  inventory: LinkObsInventory | null;
  execute: ReturnType<typeof useDocumentStore.getState>['execute'];
  testAction: (action: LinkAction) => Promise<void>;
}): JSX.Element {
  const { itemId, cue, frameRate, execute, testAction } = props;
  // The inspector stays mounted while the cue is selected: an undo elsewhere shows here, typing is never cut off.
  const name = useFieldDraft(cue.name), notes = useFieldDraft(cue.notes);
  const visual = resolveVisualCue(cue, props.inventory);
  const visibleActions = cue.actions
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => !visual || (action.id !== visual.showAction.id && action.id !== visual.transformAction?.id));
  return <div className="inspector-body cue-property-form">
    <div className="cue-detail-header">
      <TextInput className="title-input" aria-label="Cue 名称" value={name.shown} onFocus={name.begin} onChange={(event) => name.type(event.currentTarget.value)} onInput={(event) => event.currentTarget.setCustomValidity('')} onBlur={(event) => { name.end(); commitCueText(event.currentTarget, cue.name, (value) => execute(replaceCueCommand(itemId, { ...cue, name: value })), true); }} />
      <Switch className="cue-enabled" label="启用" checked={cue.enabled} onChange={(event) => execute(replaceCueCommand(itemId, { ...cue, enabled: event.currentTarget.checked }))} />
      <IconButton variant="danger" label="删除 Cue" icon={Trash2} onClick={() => execute(removeContentCommand(itemId, [{ kind: 'cue', id: cue.id }]))} />
    </div>
    <TimecodeEditor cue={cue} frameRate={frameRate} onChange={(next) => execute(moveContentCommand(itemId, { kind: 'cue', id: cue.id }, timecodeToMilliseconds(next.timecode, frameRate), cue.layerId ? { track: cue.layerId } : 'top'))} />
    <TextArea aria-label="备注" rows={1} className="cue-notes" placeholder="备注（选填）" value={notes.shown} onFocus={notes.begin} onChange={(event) => notes.type(event.currentTarget.value)} onInput={(event) => event.currentTarget.setCustomValidity('')} onBlur={(event) => { notes.end(); commitCueText(event.currentTarget, cue.notes, (value) => execute(replaceCueCommand(itemId, { ...cue, notes: value }))); }} />
    {visual ? <VisualCueLayoutEditor itemId={itemId} cueId={cue.id} visual={visual} testAction={testAction} /> : null}
    <div className="action-list">{visibleActions.map(({ action, index }) => <ActionEditor key={action.id} itemId={itemId} cueId={cue.id} action={action} index={index} actionCount={cue.actions.length} onTest={testAction} />)}</div>
  </div>;
}

function commitCueText(input: HTMLInputElement | HTMLTextAreaElement, previous: string, commit: (value: string) => void, required = false): void {
  if (input.value === previous) return;
  try {
    if (required && !input.value.trim()) throw new Error('Cue 名称不能为空');
    commit(input.value);
  } catch (error) {
    input.value = previous;
    input.setCustomValidity(error instanceof Error ? error.message : String(error));
    input.reportValidity();
  }
}

function TimecodeEditor(props: {
  cue: LinkCue;
  frameRate: LinkProject['timebase']['frameRate'];
  onChange: (cue: LinkCue) => void;
}): JSX.Element {
  return <div className="timecode-editor">
    {(['hours', 'minutes', 'seconds', 'frames'] as const).map((key) => <label key={key}><span>{{ hours: '时', minutes: '分', seconds: '秒', frames: '帧' }[key]}</span><PropertyNumberInput className="ui-input" value={props.cue.timecode[key]} min={0} max={key === 'hours' ? 23 : key === 'frames' ? nominalFramesPerSecond(props.frameRate) - 1 : 59} onCommit={(value) => props.onChange({ ...props.cue, timecode: { ...props.cue.timecode, [key]: value } })} /></label>)}
  </div>;
}

type VisualCue = {
  showAction: Extract<LinkAction, { kind: 'obs.setSceneItemEnabled' }>;
  transformAction: Extract<LinkAction, { kind: 'obs.setSceneItemTransform' }> | null;
  canvasWidth: number;
  canvasHeight: number;
  sourceWidth: number | null;
  sourceHeight: number | null;
  obsCanvasWidth: number | null;
  obsCanvasHeight: number | null;
};

function VisualCueLayoutEditor(props: { itemId: string; cueId: string; visual: VisualCue; testAction: (action: LinkAction) => Promise<void> }): JSX.Element {
  const execute = useDocumentStore((state) => state.execute);
  const current = props.visual.transformAction?.transform ?? originalTransform(props.visual);
  const replaceTransform = (transform: typeof current): Extract<LinkAction, { kind: 'obs.setSceneItemTransform' }> => {
    const action = props.visual.transformAction
      ? { ...props.visual.transformAction, transform }
      : { id: crypto.randomUUID(), label: `画面布局 · ${props.visual.showAction.sourceName}`, kind: 'obs.setSceneItemTransform' as const, sceneName: props.visual.showAction.sceneName, sourceName: props.visual.showAction.sourceName, transform };
    if (props.visual.transformAction) execute(replaceActionCommand(props.itemId, props.cueId, action));
    else execute(addActionCommand(props.itemId, props.cueId, action));
    return action;
  };
  const patch = (values: Partial<typeof current>): void => { replaceTransform({ ...current, ...values }); };
  const fitScale = props.visual.sourceWidth !== null && props.visual.sourceHeight !== null
    ? Math.min(props.visual.canvasWidth / props.visual.sourceWidth, props.visual.canvasHeight / props.visual.sourceHeight)
    : null;
  return <section className="visual-layout-editor">
    <div className="visual-source-summary" title={`OBS 场景：${props.visual.showAction.sceneName}；来源：${props.visual.showAction.sourceName}`}><small>{props.visual.sourceWidth !== null && props.visual.sourceHeight !== null ? `原始尺寸 ${Math.round(props.visual.sourceWidth)} × ${Math.round(props.visual.sourceHeight)}` : '还没读取来源尺寸'}</small>{props.visual.obsCanvasWidth !== null && (props.visual.obsCanvasWidth !== props.visual.canvasWidth || props.visual.obsCanvasHeight !== props.visual.canvasHeight) ? <em>OBS 画布为 {props.visual.obsCanvasWidth} × {props.visual.obsCanvasHeight}，请改为 1080 × 1920</em> : null}</div>
    <div className="layout-preset-row">
      <Button variant="secondary" size="sm" icon={RotateCcw} onClick={() => replaceTransform(originalTransform(props.visual))}>原始大小</Button>
      <Button variant="secondary" size="sm" icon={Crosshair} onClick={() => patch({ positionX: props.visual.canvasWidth / 2, positionY: props.visual.canvasHeight / 2, alignment: 0 })}>画布居中</Button>
      <Button variant="secondary" size="sm" icon={Maximize} disabled={fitScale === null} onClick={() => { if (fitScale !== null) replaceTransform({ ...originalTransform(props.visual), scaleX: fitScale, scaleY: fitScale }); }}>适应画布</Button>
      <Button variant="secondary" size="sm" icon={Play} title="把当前布局发送给 OBS 测试" onClick={() => void props.testAction(replaceTransform(current))}>测试画面</Button>
    </div>
    <div className="visual-layout-grid">
      <LayoutNumber label="位置 X" unit="px" value={current.positionX} onCommit={(value) => patch({ positionX: value })} />
      <LayoutNumber label="位置 Y" unit="px" value={current.positionY} onCommit={(value) => patch({ positionY: value })} />
      <LayoutNumber label="宽度" unit="%" value={current.scaleX * 100} onCommit={(value) => patch({ scaleX: Math.max(0.05, value / 100) })} />
      <LayoutNumber label="高度" unit="%" value={current.scaleY * 100} onCommit={(value) => patch({ scaleY: Math.max(0.05, value / 100) })} />
      <LayoutNumber label="旋转" unit="°" value={current.rotation} onCommit={(value) => patch({ rotation: value })} />
      <Switch className="visual-toggle" label="画面显示" checked={props.visual.showAction.enabled} onChange={(event) => execute(replaceActionCommand(props.itemId, props.cueId, { ...props.visual.showAction, enabled: event.currentTarget.checked }))} />
      <LayoutNumber label="上裁剪" unit="px" value={current.cropTop} onCommit={(value) => patch({ cropTop: Math.max(0, Math.round(value)) })} />
      <LayoutNumber label="右裁剪" unit="px" value={current.cropRight} onCommit={(value) => patch({ cropRight: Math.max(0, Math.round(value)) })} />
      <LayoutNumber label="下裁剪" unit="px" value={current.cropBottom} onCommit={(value) => patch({ cropBottom: Math.max(0, Math.round(value)) })} />
      <LayoutNumber label="左裁剪" unit="px" value={current.cropLeft} onCommit={(value) => patch({ cropLeft: Math.max(0, Math.round(value)) })} />
    </div>
  </section>;
}

function resolveVisualCue(cue: LinkCue, inventory: LinkObsInventory | null): VisualCue | null {
  const showAction = cue.actions.find((action): action is VisualCue['showAction'] => action.kind === 'obs.setSceneItemEnabled');
  if (!showAction) return null;
  const transformAction = cue.actions.find((action): action is NonNullable<VisualCue['transformAction']> => action.kind === 'obs.setSceneItemTransform' && action.sceneName === showAction.sceneName && action.sourceName === showAction.sourceName) ?? null;
  const sourceSize = resolveObsSourceSize(inventory, showAction.sceneName, showAction.sourceName);
  return {
    showAction,
    transformAction,
    canvasWidth: 1080,
    canvasHeight: 1920,
    sourceWidth: sourceSize?.width ?? null,
    sourceHeight: sourceSize?.height ?? null,
    obsCanvasWidth: inventory?.videoSettings?.baseWidth ?? null,
    obsCanvasHeight: inventory?.videoSettings?.baseHeight ?? null
  };
}

function originalTransform(visual: VisualCue): NonNullable<VisualCue['transformAction']>['transform'] {
  return { positionX: visual.canvasWidth / 2, positionY: visual.canvasHeight / 2, scaleX: 1, scaleY: 1, rotation: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0, alignment: 0 };
}

