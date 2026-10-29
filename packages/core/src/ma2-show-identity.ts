import type { LinkProject } from '@tb/schema';

/** Shows an item's MA2 cues were picked from, as gma.show.getvar('SHOWFILE')
 * reported them when the library or timecodes were read. Empty when the item
 * sends no MA2 cue. Template origins are not playback sources and are ignored. */
export function expectedMa2Shows(project: LinkProject, itemId: string): string[] {
  const lighting = project.rundown.find(item => item.id === itemId)?.lighting;
  const sendsMa2 = Boolean(lighting?.ma2Bindings?.length
    || lighting?.tracks.some(track => track.clips.some(clip => clip.events.some(event => event.kind === 'ma2'))));
  if (!lighting || !sendsMa2) return [];
  return [...new Set([lighting.ma2Library?.show, project.ma2MaterialLibrary?.library?.directory.show, project.ma2ReadState?.catalog.directory.show]
    .filter((show): show is string => Boolean(show)))];
}

/**
 * A note, never a stop (2026-10-28): the operator saves the console Show under a new name every day, the
 * timecode runs the lights by the MTC start whatever the Show is called, and a reconnect reads the new Show.
 * Only Cues fired directly by number may point elsewhere when the Show's content changed too.
 */
export function ma2ShowMismatch(expected: readonly string[], current: string): string | null {
  if (!expected.length || expected.includes(current)) return null;
  return `控台现在加载的 Show 是“${current}”，上次读取的是“${expected.join('”或“')}”。时间码照常按起始码跑灯；重新连接控台会读取现在的 Show。如果 Show 内容也换了，直接按编号触发的 Cue 可能打到别的对象。`;
}
