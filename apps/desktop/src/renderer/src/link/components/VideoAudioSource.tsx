import { Button } from '../ui';
import { useState } from 'react';
import { setReferenceAudioCommand } from '@tb/core/link';
import type { LinkMediaAsset } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { formatMilliseconds } from './media-utils';

export function VideoAudioSource(props: { itemId: string; asset: LinkMediaAsset; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const reference = useDocumentStore((state) => state.project?.rundown.find((item) => item.id === props.itemId)?.referenceAudio);
  const selected = reference?.sourceMediaAssetId === props.asset.id;
  const bindVideoAudio = async (): Promise<void> => {
    const { path, documentId } = useDocumentStore.getState();
    if (!path || !props.asset.durationMs) { props.notify('请先保存工程，并等视频时长读取完成', 'error'); return; }
    setBusy(true);
    try {
      const directory = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
      const audio = await linkDesktopViewModel.importReferenceAudio({ projectPath: path, sourcePath: directory + props.asset.relativePath, durationMs: props.asset.durationMs });
      useDocumentStore.getState().executeForDocument(documentId, setReferenceAudioCommand(props.itemId, { ...audio, sourceMediaAssetId: props.asset.id }));
      props.notify('已把视频的完整原声作为歌曲音轨，节目时长已更新');
    } catch (error) { props.notify(`提取视频原声失败：${error instanceof Error ? error.message : String(error)}`, 'error'); }
    finally { setBusy(false); }
  };
  return <section className="video-audio-property">
    <span title={selected ? `正在使用此视频原声 · ${formatMilliseconds(reference.durationMs)}` : `当前歌曲时长 ${formatMilliseconds(reference?.durationMs ?? 0)}`}>歌曲音轨</span>
    <Button variant="secondary" size="sm" loading={busy} title="提取完整视频原声作为歌曲音轨，节目时长随之更新" disabled={selected} onClick={() => void bindVideoAudio()}>{busy ? '正在提取原声…' : selected ? '已使用视频原声' : '使用视频原声'}</Button>
  </section>;
}

