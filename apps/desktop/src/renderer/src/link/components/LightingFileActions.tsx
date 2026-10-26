import { FolderOpen, FileMusic, FileJson, ChevronRight } from 'lucide-react';
import { useRef, useState } from 'react';
import { exportLightingMidi, importLightingMidi, importLightingReaper, appendLightingDocument, type LightingImport } from '@tb/core/link';
import { lightingDocumentSchema, type LightingDocument } from '@tb/schema';
import type { LightingTimelineProps } from './LightingTimeline';
import { linkFileViewModel } from '../view-models/link-desktop-view-model';

export function LightingFileActions(props: { document: LightingDocument; onChange: LightingTimelineProps['onChange']; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<LightingImport | null>(null);
  const [busy, setBusy] = useState(false);
  const fail = (error: unknown): void => props.notify(error instanceof Error ? error.message : String(error), 'error');
  const read = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return; setBusy(true);
    try {
      const all = [...files]; const file = all.find((entry) => /\.rpp$/i.test(entry.name)) ?? all[0]; if (!file) return;
      if (file.size > 32 * 1024 * 1024) throw new Error('灯光文件超过 32 MB');
      if (/\.rpp$/i.test(file.name)) {
        const external = new Map<string, Uint8Array>();
        for (const midi of all.filter((entry) => /\.midi?$/i.test(entry.name))) {
          if (midi.size > 32 * 1024 * 1024) throw new Error(`MIDI 文件超过 32 MB：${midi.name}`);
          const path = linkFileViewModel.getPathForFile(midi) || midi.webkitRelativePath || midi.name;
          if (external.has(path)) throw new Error(`MIDI 文件重复或无法区分：${midi.name}`);
          external.set(path, new Uint8Array(await midi.arrayBuffer()));
        }
        setPreview(importLightingReaper(await file.text(), external, linkFileViewModel.getPathForFile(file)));
      } else if (/\.midi?$/i.test(file.name)) setPreview(importLightingMidi(new Uint8Array(await file.arrayBuffer())));
      else setPreview({ document: lightingDocumentSchema.parse(JSON.parse(await file.text())), warnings: [] });
    } catch (error) { setPreview(null); fail(error); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  const apply = (): void => {
    if (!preview) return;
    props.onChange(appendLightingDocument(props.document, preview.document), '导入灯光工程');
    setPreview(null);
  };
  return <>
    <input hidden ref={input} type="file" multiple accept=".mid,.midi,.rpp,.json" onChange={(event) => void read(event.target.files)} />
    <button className="lighting-file-operation" aria-label="导入灯光" disabled={busy} onClick={() => input.current?.click()}><FolderOpen /><span><strong>{busy ? '读取中…' : '导入灯光'}</strong><small>从 MIDI、REAPER 或灯光工程添加编排</small></span><ChevronRight /></button>
    <button className="lighting-file-operation" aria-label="导出 MIDI" onClick={() => { try { download(new Blob([new Uint8Array(exportLightingMidi(props.document))], { type: 'audio/midi' }), '灯光编排.mid'); } catch (error) { fail(error); } }}><FileMusic /><span><strong>导出 MIDI</strong><small>用于其他支持 MIDI 的软件</small></span><ChevronRight /></button>
    <button className="lighting-file-operation" aria-label="导出灯光工程" onClick={() => download(new Blob([JSON.stringify(props.document, null, 2)], { type: 'application/json' }), '灯光编排.tblight.json')}><FileJson /><span><strong>导出灯光工程</strong><small>保存完整灯光编排，便于备份或再次导入</small></span><ChevronRight /></button>
    {preview ? <div className="lighting-import-preview" role="region" aria-label="灯光导入预览"><strong>导入 {preview.document.tracks.length} 条轨道 · {preview.document.tracks.reduce((sum, track) => sum + track.clips.reduce((total, clip) => total + clip.events.length, 0), 0)} 个事件 · {preview.document.templates.length} 个模板{preview.document.ma2Bindings?.length ? ` · ${preview.document.ma2Bindings.length} 个 MA2 绑定` : ''}</strong>
      {preview.warnings.map((warning) => <p key={warning}>{warning}</p>)}
      <button disabled={busy} onClick={() => { try { apply(); } catch (error) { fail(error); } }}>确认导入</button><button onClick={() => setPreview(null)}>取消</button>
    </div> : null}
  </>;
}
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
