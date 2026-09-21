import { useMemo } from 'react';
import { matchMa2Programs } from '@tb/core/link';
import type { LinkProject, Ma2Catalog } from '@tb/schema';

export function P1LightingImportReport({ project, catalog }: { project: LinkProject; catalog: Ma2Catalog }): JSX.Element {
  const report = useMemo(() => {
    const songs = project.rundown.filter(item => item.p1Media || item.p1UnavailableSourceKey).map(item => ({
      id: item.id, title: item.title, unavailable: Boolean(item.p1UnavailableSourceKey),
      bindings: item.lighting?.ma2Bindings?.length ?? 0,
      events: item.lighting?.ma2Bindings?.reduce((count, binding) => count + binding.baselineTracks.reduce((total, track) => total + track.clips.reduce((sum, clip) => sum + clip.events.length, 0), 0), 0) ?? 0
    }));
    return { songs, unresolved: matchMa2Programs(project, catalog).unresolved };
  }, [project, catalog]);
  const missing = report.songs.filter(song => !song.bindings);
  return <div aria-label="音乐与灯光导入结果">
    <h4>{missing.length || report.unresolved.length ? '音乐与灯光尚未全部配对' : '歌曲灯光已导入，可在编辑器切换歌曲查看'}</h4>
    <p>已关联 {report.songs.length - missing.length} / {report.songs.length} 首歌曲。以下统计为本次读取后工程中已绑定的灯光事件，不代表控台播放验证。</p>
    <ul>{report.songs.map(song => <li key={song.id}>{song.title}：{song.unavailable ? '音频待修复' : song.bindings ? `${song.events} 个 Cue / 灯光事件 · ${song.bindings} 条时间线` : '未导入对应 Cue，请在下方选择时间线对应歌曲'}</li>)}</ul>
    {report.unresolved.length ? <details open><summary>控台时间线待核对</summary><ul>{report.unresolved.map(entry => <li key={entry.target}>Timecode {entry.target}：{entry.reason}</li>)}</ul></details> : null}
  </div>;
}
