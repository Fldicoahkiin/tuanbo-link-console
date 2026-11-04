import { useRef, useState, type ReactNode } from 'react';
import { FileAudio2, Flower2, FolderOpen, ListMusic } from 'lucide-react';
import { setPlaybackSourceCommand } from '@tb/core/link';
import { Button, Card, ChoiceGroup, Disclosure } from '../ui';
import { P1ProjectSyncPanel } from './P1ProjectSyncPanel';
import { importProgramFiles } from './import-program-files';
import { assertDocumentSession, useDocumentStore } from '../stores/document-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

type Source = 'p1' | 'local' | 'xiaohonghua';
type Props = { disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void; children?: ReactNode };

export function SongImportSettings({ disabled, notify, children }: Props): JSX.Element {
  const [source, setSource] = useState<Source>('p1');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const importAudio = async (files: File[]): Promise<void> => {
    if (disabled || pending.current || !files.length) return;
    pending.current = true; setBusy(true); setResult('');
    try {
      const initial = useDocumentStore.getState();
      if (!initial.project) {
        const project = await linkDesktopViewModel.createProject('歌曲联动工程');
        if (useDocumentStore.getState().documentId !== initial.documentId || useDocumentStore.getState().project) throw new Error('工程已切换，请在当前工程重新导入');
        useDocumentStore.getState().setProject(project, null);
      }
      const document = useDocumentStore.getState();
      const before = document.project?.rundown.length ?? 0;
      await importProgramFiles(files, 'all', (message, tone) => { setResult(message); notify(message, tone); });
      const current = assertDocumentSession(document.documentId);
      if ((current.project?.rundown.length ?? 0) > before) {
        current.executeForDocument(document.documentId, setPlaybackSourceCommand('internal'));
      }
    } catch (error) { const message = error instanceof Error ? error.message : String(error); setResult(message); notify(message, 'error'); }
    finally { pending.current = false; setBusy(false); }
  };
  return <section className="settings-stack" aria-label="歌曲导入">
    <ChoiceGroup<Source> label="选择歌曲来源" value={source} disabled={busy || disabled} onChange={setSource} choices={[
      { value: 'p1', title: 'P1 工程', icon: ListMusic, help: '歌曲、裁剪、原始时间码' },
      { value: 'local', title: '本地音频', icon: FileAudio2, help: '选择电脑上的歌曲文件' },
      { value: 'xiaohonghua', title: '小红花音效助手', icon: Flower2, help: '原始音频与接入范围' }
    ]} />
    <div hidden={source !== 'p1'} className="settings-stack">
      <Card title="从 P1 工程导入"><P1ProjectSyncPanel purpose="audio" directImport disabled={disabled || busy} notify={notify} onBusyChange={setBusy} /></Card>
      <Disclosure title="继续使用 P1 播放：跟随与写回"><fieldset className="settings-fieldset" disabled={disabled || busy}>{children}</fieldset></Disclosure>
    </div>
    <div hidden={source === 'p1'} className="settings-stack">
      <Card title={source === 'xiaohonghua' ? '导入自己保留的原始歌曲或音效' : '导入音频到节目单'} description="可以一次选多首音频，导入后由联动台播放。普通音频不带控台时间码，灯光要另外编排或配对。">
        <div className="settings-actions-row"><Button variant="primary" icon={FolderOpen} loading={busy} disabled={disabled || busy} onClick={() => input.current?.click()}>{busy ? '正在导入…' : '选择音频文件'}</Button></div>
        <input hidden ref={input} type="file" multiple accept="audio/*,.wav,.mp3,.flac,.m4a,.aac,.ogg,.wma" aria-label="导入本地音频文件" onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void importAudio(files); }} />
        {result ? <p role="status">{result}</p> : null}
      </Card>
      {source === 'xiaohonghua' ? <Card title="小红花接入范围">
        <p>可以用：你自己保存的原始音频文件。</p>
        <p>暂不支持：小红花备份包、内置音效、分类和剪辑设置，以及跟随小红花播放和时间码同步。</p>
        <p>按小红花官方说明，备份包只能在小红花软件里用。目前拿不到它的播放位置，用快捷键触发不等于同步。</p>
      </Card> : null}
    </div>
  </section>;
}
