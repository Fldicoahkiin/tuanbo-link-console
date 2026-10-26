import type { LinkProject } from '@tb/schema';
import { nativeProgramSnapshot } from './native-program-snapshot';
import { songLightingStatus } from './song-lighting-status';

/**
 * Checked when a song starts. Since 2026-10-26 nothing here holds a song or its timecode back: the
 * timecode is the only route to the console and the console runs whatever it holds, so a song can be
 * played at any time, finished or not. The answer is a warning shown with the playing song (edits not
 * yet on the console, lighting that needs attention, a port or frame rate that does not match); null
 * when there is nothing to say. A song without lighting work has nothing to check.
 * `ports` lists the MIDI outputs present now; null when they were not queried
 * (the engine reports a port it cannot open when it prepares).
 */
export function lightingStartCheck(project: LinkProject, itemId: string, mtc: { portName: string | null; ports: readonly string[] | null }): string | null {
  const status = songLightingStatus(project, itemId);
  switch (status.state) {
    case 'unmatched': return null;
    case 'editing': return `控台上还是上一版：这首歌还有 ${status.pending} 项改动没同步到控台，这次时间码触发的是控台上现有的灯光；停止播放后会自动同步`;
    case 'attention': return `这首歌的灯光需要处理：${status.reasons.join('；')}。时间码照常发送`;
    case 'ready': {
      const problems: string[] = [];
      if (!mtc.portName) problems.push('没有选择时间码输出端口');
      else if (mtc.ports && !mtc.ports.includes(mtc.portName)) problems.push(`找不到时间码输出端口：${mtc.portName}`);
      const prepared = nativeProgramSnapshot(project, itemId, 0, undefined, 48000);
      if (!prepared.allowMtc) problems.push(prepared.notice ?? '这次不能发送时间码');
      if (project.timebase.frameRate !== status.frameRate) problems.push(`帧率不一致：工程是 ${project.timebase.frameRate} FPS，控台上是 ${status.frameRate} FPS`);
      return problems.length ? `这首歌可以播放，但${problems.join('；')}` : null;
    }
  }
}
