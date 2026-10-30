import { useRef, useState, type ReactNode } from 'react';
import { FileAudio2, Flower2, FolderOpen, ListMusic } from 'lucide-react';
import { setPlaybackSourceCommand } from '@tb/core/link';
import { Button } from '../ui/Button';
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
  return <section className="song-import-settings" aria-label="歌曲导入">
    <div className="song-source-picker" role="group" aria-label="选择歌曲来源">
      <Button disabled={busy || disabled} aria-pressed={source === 'p1'} onClick={() => setSource('p1')}><ListMusic /><span><strong>P1 工程</strong><small>歌曲、裁剪、原始时间码</small></span></Button>
      <Button disabled={busy || disabled} aria-pressed={source === 'local'} onClick={() => setSource('local')}><FileAudio2 /><span><strong>本地音频</strong><small>选择电脑上的歌曲文件</small></span></Button>
      <Button disabled={busy || disabled} aria-pressed={source === 'xiaohonghua'} onClick={() => setSource('xiaohonghua')}><Flower2 /><span><strong>小红花音效助手</strong><small>原始音频与接入范围</small></span></Button>
    </div>
    <div hidden={source !== 'p1'}>
      <P1ProjectSyncPanel purpose="audio" directImport disabled={disabled || busy} notify={notify} onBusyChange={setBusy} />
      <details className="device-advanced"><summary>继续使用 P1 播放：跟随与写回</summary><fieldset disabled={disabled || busy}>{children}</fieldset></details>
    </div>
    <div hidden={source === 'p1'} className="song-file-import">
      <h3>{source === 'xiaohonghua' ? '导入自己保留的原始歌曲或音效' : '导入音频到节目单'}</h3>
      <p className="settings-note">可以一次选择多首音频，导入后由联动台播放。普通音频不带控台时间码，灯光需要另外编排或配对。</p>
      <Button className="primary-button" disabled={disabled || busy} onClick={() => input.current?.click()}><FolderOpen />{busy ? '正在导入…' : '选择音频文件'}</Button>
      <input hidden ref={input} type="file" multiple accept="audio/*,.wav,.mp3,.flac,.m4a,.aac,.ogg,.wma" aria-label="导入本地音频文件" onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void importAudio(files); }} />
      {result ? <p className="settings-note" role="status">{result}</p> : null}
      {source === 'xiaohonghua' ? <div className="song-source-limits">
        <h4>小红花接入范围</h4>
        <p>可使用：你自己保存的原始音频文件。</p>
        <p>暂不支持：小红花备份包、内置音效、分类和剪辑设置，以及跟随小红花播放和时间码同步。</p>
        <p className="settings-note">按小红花官方说明，备份包只能在小红花软件里使用。目前拿不到它的播放位置，用快捷键触发不等于同步。</p>
      </div> : null}
    </div>
  </section>;
}
