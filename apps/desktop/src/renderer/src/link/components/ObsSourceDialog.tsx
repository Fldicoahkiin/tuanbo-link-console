import { Button } from './Button';
import { useState } from 'react';
import { ModalSurface } from './ModalSurface';
import { createPortal } from 'react-dom';
import { obsSourceKinds, obsSourceSettingsSchema, type ObsSourceDraft, type ObsSourceKind, type ObsSourceOption, type ObsSourceSettings } from '@tb/schema';
import { linkDesktopViewModel, linkFileViewModel } from '../view-models/link-desktop-view-model';
import { useIntegrationStore } from '../stores/integration-store';

type Props = { kind: ObsSourceKind; scenes: string[]; onClose: () => void; asset?: { name: string; projectPath: string; relativePath: string } };
export function ObsSourceDialog(props: Props): JSX.Element {
  const [name, setName] = useState<string>(props.asset?.name ?? obsSourceKinds[props.kind].label);
  const [sceneName, setSceneName] = useState(props.scenes[0] ?? '');
  const [draft, setDraft] = useState<ObsSourceDraft | null>(null);
  const [options, setOptions] = useState<ObsSourceOption[]>([]);
  const [settings, setSettings] = useState<ObsSourceSettings>(() => obsSourceSettingsSchema.parse({}));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [applied, setApplied] = useState(false);
  const update = (value: Partial<ObsSourceSettings>): void => setSettings((current) => ({ ...current, ...value }));
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError('');
    try { await action(); } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure); setError(message);
      try { await linkDesktopViewModel.recordLog({ level: 'error', category: 'device', device: 'obs', result: 'failed', message: `添加 OBS 来源失败：${message}` }); }
      catch (logError) { setError(`${message}；日志写入失败：${String(logError)}`); }
    }
    finally { setBusy(false); }
  };
  const refresh = async (source: ObsSourceDraft): Promise<void> => setOptions(await linkDesktopViewModel.readObsSourceOptions(source.inputName));
  const create = (): Promise<void> => run(async () => {
    const source = await linkDesktopViewModel.createObsSource({ kind: props.kind, name, sceneName });
    setDraft(source);
    await refresh(source);
  });
  const finish = (): Promise<void> => run(async () => {
    if (!draft) return;
    if (!applied) { await linkDesktopViewModel.applyObsSource({ inputName: draft.inputName, settings, ...(props.asset ? { projectAsset: { projectPath: props.asset.projectPath, relativePath: props.asset.relativePath } } : {}) }); setApplied(true); }
    useIntegrationStore.getState().setInventory(await linkDesktopViewModel.readObsInventory());
    props.onClose();
  });
  const close = (): Promise<void> => run(async () => {
    if (draft && !applied) await linkDesktopViewModel.cancelObsSource(draft.inputName);
    props.onClose();
  });
  return createPortal(<ModalSurface className="obs-source-dialog" label={`添加${obsSourceKinds[props.kind].label}`} onClose={() => { if (!busy) void close(); }}><form onSubmit={(event) => { event.preventDefault(); void (draft ? finish() : create()); }}>
    <h3>添加{obsSourceKinds[props.kind].label}</h3>
    <fieldset disabled={busy || applied}>
      <label>名称<input autoFocus required maxLength={100} value={name} disabled={draft !== null} onChange={(event) => setName(event.target.value)} /></label>
      <label>应用到场景<select required value={sceneName} disabled={draft !== null} onChange={(event) => setSceneName(event.target.value)}><option value="">选择 OBS 场景</option>{props.scenes.map((scene) => <option key={scene}>{scene}</option>)}</select></label>
      {props.asset ? <p>素材：{props.asset.name}</p> : null}
      {draft && !props.asset ? <SourceFields kind={props.kind} settings={settings} options={options} onUpdate={update} onRefresh={() => void run(() => refresh(draft))} /> : null}
    </fieldset>
    {error ? <p role="alert" className="obs-source-error">{error}</p> : null}
    <footer><Button type="button" className="secondary-button" disabled={busy} onClick={() => void close()}>{applied ? '关闭' : '取消'}</Button><Button className="primary-button" disabled={busy || !sceneName}>{busy ? '正在同步…' : applied ? '刷新场景列表' : draft ? '添加到 OBS 场景' : '下一步'}</Button></footer>
  </form></ModalSurface>, document.body);
}

function SourceFields(props: { kind: ObsSourceKind; settings: ObsSourceSettings; options: ObsSourceOption[]; onUpdate: (value: Partial<ObsSourceSettings>) => void; onRefresh: () => void }): JSX.Element {
  const { settings, onUpdate } = props;
  if (props.kind === 'image') return <label>图片文件<input type="file" accept="image/*,.png,.jpg,.jpeg,.webp,.gif,.bmp" onChange={(event) => { const file = event.target.files?.[0]; if (file) onUpdate({ path: linkFileViewModel.getPathForFile(file) }); }} /><small>{settings.path || '选择本机图片文件'}</small></label>;
  if (obsSourceKinds[props.kind].property) return <label>设备 / 窗口<div className="obs-device-picker"><select required value={settings.device} onChange={(event) => onUpdate({ device: event.target.value })}><option value="">请选择</option>{props.options.map((option) => <option key={option.value} value={option.value} disabled={!option.enabled}>{option.label}</option>)}</select><button type="button" onClick={props.onRefresh}>刷新</button></div>{!props.options.some((option) => option.enabled) ? <small>未检测到可用设备，请检查连接后刷新。</small> : null}</label>;
  if (props.kind === 'text') return <><label>文本内容<textarea required rows={5} value={settings.text} onChange={(event) => onUpdate({ text: event.target.value })} /></label><label>字号<input type="number" min={6} max={1000} value={settings.fontSize} onChange={(event) => onUpdate({ fontSize: Number(event.target.value) })} /></label></>;
  if (props.kind === 'browser') return <><label>网页地址<input required type="url" placeholder="https://" value={settings.url} onChange={(event) => onUpdate({ url: event.target.value })} /></label><div className="obs-source-dimensions">{(['width', 'height'] as const).map((key) => <label key={key}>{key === 'width' ? '宽度' : '高度'}<input type="number" min={1} max={8192} value={settings[key]} onChange={(event) => onUpdate({ [key]: Number(event.target.value) })} /></label>)}</div></>;
  return <><label>媒体文件<input type="file" accept="video/*,audio/*,.mkv,.mov,.mp4,.mp3,.wav,.flac,.webm" onChange={(event) => { const file = event.target.files?.[0]; if (file) onUpdate({ path: linkFileViewModel.getPathForFile(file) }); }} /><small>{settings.path || '选择本机视频或音频文件'}</small></label><label className="obs-source-checkbox"><input type="checkbox" checked={settings.looping} onChange={(event) => onUpdate({ looping: event.target.checked })} />循环播放</label></>;
}
