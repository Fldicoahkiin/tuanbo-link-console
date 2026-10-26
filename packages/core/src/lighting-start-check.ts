import type { LinkProject } from '@tb/schema';
import { nativeProgramSnapshot } from './native-program-snapshot';
import { songLightingStatus } from './song-lighting-status';

/**
 * Checked before a song starts (decided 2026-10-23). A song without lighting work
 * plays as before. A song with lighting that is not up to date on the console,
 * or that is ready but whose timecode port, start code or frame rate does not
 * check out, returns the reason; the operator then plays it without lighting or
 * cancels. The route never changes after the song has started.
 * `ports` lists the MIDI outputs present now; null when they were not queried
 * (the engine reports a port it cannot open when it prepares).
 */
export function lightingStartCheck(project: LinkProject, itemId: string, mtc: { portName: string | null; ports: readonly string[] | null }): string | null {
  const status = songLightingStatus(project, itemId);
  switch (status.state) {
    case 'unmatched': return null;
    case 'editing': return `控台上的节目还没同步最新改动（${status.pending} 项），带灯光播放会用控台上的旧版本。请先同步到控台，或选择不带灯光播放。`;
    case 'attention': return `这首歌的灯光需要处理：${status.reasons.join('；')}`;
    case 'ready': {
      const problems: string[] = [];
      if (!mtc.portName) problems.push('没有选择时间码输出端口');
      else if (mtc.ports && !mtc.ports.includes(mtc.portName)) problems.push(`找不到时间码输出端口：${mtc.portName}`);
      const prepared = nativeProgramSnapshot(project, itemId, 0, undefined, 48000);
      if (!prepared.allowMtc) problems.push(prepared.notice ?? '这次不能发送时间码');
      else if (prepared.snapshot.offsetMs !== status.startMs) problems.push(`起始码不一致：将发送 ${prepared.snapshot.offsetMs} ms，控台上是 ${status.startMs} ms`);
      if (project.timebase.frameRate !== status.frameRate) problems.push(`帧率不一致：工程是 ${project.timebase.frameRate} FPS，控台上是 ${status.frameRate} FPS`);
      return problems.length ? `这首歌可以播放，但${problems.join('；')}` : null;
    }
  }
}
