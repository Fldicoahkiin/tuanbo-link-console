import { useMemo } from 'react';
import { matchMa2Programs } from '@tb/core/link';
import type { LinkProject, Ma2Catalog } from '@tb/schema';

export function P1LightingImportReport({ project, catalog }: { project: LinkProject; catalog: Ma2Catalog }): JSX.Element {
  const report = useMemo(() => {
    const songs = project.rundown.filter(item => item.referenceAudio || item.p1Media || item.p1UnavailableSourceKey).map(item => ({
      id: item.id, title: item.title, unavailable: Boolean(item.p1UnavailableSourceKey),
      bindings: item.lighting?.ma2Bindings?.length ?? 0,
      events: item.lighting?.ma2Bindings?.reduce((count, binding) => count + binding.baselineTracks.reduce((total, track) => total + track.clips.reduce((sum, clip) => sum + clip.events.length, 0), 0), 0) ?? 0
    }));
    return { songs, unresolved: matchMa2Programs(project, catalog).unresolved };
  }, [project, catalog]);
  const missing = report.songs.filter(song => !song.bindings);
  const stale = Object.values(project.ma2ReadState?.pairings ?? {}).filter(pair => pair.status === 'stale').length;
  return <div aria-label="音乐与灯光导入结果">
    <h4>{missing.length || report.unresolved.length || stale ? '音乐与灯光有待处理项' : '歌曲灯光已导入，可在编辑器切换歌曲查看'}</h4>
    <p>已关联 {report.songs.length - missing.length} / {report.songs.length} 首歌曲。以下统计为本次读取后工程中已绑定的灯光事件，不代表控台播放验证。</p>
    <p>{catalog.entries.filter(entry => entry.preview?.unconverted.length).length} 条含控台专有动作 · {report.unresolved.length} 条待配对 · {catalog.entries.filter(entry => entry.error).length} 条读取异常。详情在“配对与查看 Cue”中筛选。</p>
    {stale ? <p role="alert">{stale} 条已有对应关系需要重新核对，保留本地 Cue；这些歌曲暂不输出灯光时间码，音频仍可播放。</p> : null}
  </div>;
}
