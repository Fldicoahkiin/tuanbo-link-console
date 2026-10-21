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

export function ma2ShowMismatch(expected: readonly string[], current: string): string | null {
  if (!expected.length || expected.includes(current)) return null;
  return `控台当前加载的 show 是“${current}”，灯光 Cue 依据“${expected.join('”或“')}”编写，Cue 编号可能不存在或指向其他对象。请在控台加载对应 show，或在灯光工作台重新读取素材后核对。`;
}
