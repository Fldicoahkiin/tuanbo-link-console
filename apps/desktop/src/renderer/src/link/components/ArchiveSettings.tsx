import { useEffect, useState } from 'react';
import { FolderInput, FolderOpen, RotateCcw } from 'lucide-react';
import { projectArchiveNameTemplateSchema, type ProjectArchiveSettingsAction, type ProjectArchiveSettingsStatus } from '@tb/schema';
import { Button } from '../ui/Button';
import { SettingsActions, SettingsField, SettingsGroup, SettingsSwitch } from './SettingsControls';
import { useDocumentStore } from '../stores/document-store';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';

const DEFAULT_TEMPLATE = '{工程名} {日期} {时间} {类型}';

function exampleName(template: string, project: string): string {
  const now = new Date(); const pad = (value: number): string => String(value).padStart(2, '0');
  return template.replaceAll('{工程名}', project).replaceAll('{日期}', `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
    .replaceAll('{时间}', `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`).replaceAll('{类型}', '同步前');
}
function readableSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Machine-level archive settings; only archives this program recorded are counted or trimmed. */
export function ArchiveSettings({ disabled }: { disabled: boolean }): JSX.Element {
  const projectName = useDocumentStore(state => state.project?.name) ?? '我的工程';
  const [status, setStatus] = useState<ProjectArchiveSettingsStatus | null>(null);
  const [keep, setKeep] = useState('');
  const [template, setTemplate] = useState('');
  const [error, setError] = useState('');
  const run = async (request: ProjectArchiveSettingsAction): Promise<void> => {
    try {
      const next = await desktop.projectArchiveSettings(request);
      setStatus(next); setKeep(String(next.settings.keep)); setTemplate(next.settings.nameTemplate); setError('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  useEffect(() => { void run({ action: 'status' }); }, []);
  if (!status) return <p className="settings-note" role={error ? 'alert' : 'status'}>{error || '正在读取存档设置…'}</p>;
  const save = (patch: { enabled?: boolean; keep?: number; nameTemplate?: string }): void => {
    const count = patch.keep ?? Number(keep);
    if (!Number.isInteger(count) || count < 1 || count > 500) { setError('保留份数请填 1 到 500 之间的整数'); return; }
    const name = projectArchiveNameTemplateSchema.safeParse(patch.nameTemplate ?? template);
    if (!name.success) { setError(name.error.issues[0]?.message ?? '文件名模板无效'); return; }
    void run({ action: 'save', enabled: patch.enabled ?? status.settings.enabled, keep: count, nameTemplate: name.data });
  };
  return <fieldset className="settings-form" disabled={disabled}>
    <SettingsGroup title="同步前自动存档" description="写入控台前，先把整个工程另存一份，出错时可以从存档恢复。">
      <SettingsSwitch label="自动存档" checked={status.settings.enabled} onChange={event => save({ enabled: event.currentTarget.checked })}
        help="关闭后写入控台前不再备份。点“保存”时创建的手动存档不受影响。" />
    </SettingsGroup>
    <SettingsGroup title="存档位置" description="每个工程一个文件夹。恢复存档时会写回原工程位置，素材从原工程文件夹读取。">
      <p className="settings-note">{status.directory}</p>
      <p className="settings-note">已占用 {readableSize(status.usageBytes)}，共 {status.fileCount} 个存档（只统计联动台创建的存档）。</p>
      <SettingsActions>
        <Button className="secondary-button" onClick={() => void run({ action: 'open-directory' })}><FolderOpen />打开文件夹</Button>
        <Button className="secondary-button" onClick={() => void run({ action: 'choose-directory' })}><FolderInput />更改位置</Button>
        {status.settings.directory ? <Button className="secondary-button" onClick={() => void run({ action: 'reset-directory' })}><RotateCcw />恢复默认位置</Button> : null}
      </SettingsActions>
    </SettingsGroup>
    <SettingsGroup title="保留与命名">
      <SettingsField label="每个工程保留" help="超出份数时，最早的自动存档移到回收站。手动存档不会被清理。">
        {props => <input {...props} type="number" min={1} max={500} value={keep} onChange={event => setKeep(event.currentTarget.value)} onBlur={() => save({})} />}
      </SettingsField>
      <SettingsField label="文件名" wide help={`例如：${exampleName(template, projectName)}.tblink。可用 {工程名} {日期} {时间} {类型}，同一秒重名时自动加序号。`}>
        {props => <input {...props} value={template} maxLength={120} onChange={event => setTemplate(event.currentTarget.value)} onBlur={() => save({})} />}
      </SettingsField>
      {template !== DEFAULT_TEMPLATE ? <SettingsActions><Button className="secondary-button" onClick={() => { setTemplate(DEFAULT_TEMPLATE); save({ nameTemplate: DEFAULT_TEMPLATE }); }}><RotateCcw />恢复默认文件名</Button></SettingsActions> : null}
    </SettingsGroup>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
  </fieldset>;
}
