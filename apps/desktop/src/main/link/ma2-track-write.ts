import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';
import { inspectMa2TimecodeXml, validateMa2TimecodeWrite } from './ma2-timecode-xml';

/** Add the native Master subtrack only to explicitly requested executor tracks. */
export function appendMa2MasterSubtracks(xml: string, target: number, trackPaths: readonly string[]): { xml: string; paths: Map<string, string> } {
  validateMa2TimecodeWrite(xml);
  const report = inspectMa2TimecodeXml(xml);
  const timecode = report.timecodes[0];
  if (report.timecodes.length !== 1 || timecode?.index !== target - 1) throw new Error('推杆子轨道目标与 Timecode 不一致');
  if (!trackPaths.length) return { xml, paths: new Map() };
  if (report.version !== '3.3.4') throw new Error('该 MA2 版本的 Master 子轨道尚未验证');
  const available = new Map(timecode.tracks.map((track) => [`Timecode:${timecode.index}/Track:${track.index}`, track]));
  if (new Set(trackPaths).size !== trackPaths.length || trackPaths.some((path) => !available.has(path))) throw new Error('推杆子轨道的目标轨道不存在或重复');
  if (trackPaths.some((path) => available.get(path)!.subtracks.some((subtrack) => subtrack.attributes.fader_command === 'Master'))) throw new Error('目标轨道已有 Master 子轨道');
  const namespace = 'http://schemas.malighting.de/grandma2/xml/MA';
  const document = new DOMParser({ onError: (_level, message) => { throw new Error(`MA2 XML 解析失败：${message}`); } }).parseFromString(xml.replace(/^\uFEFF/, ''), 'application/xml');
  const nodes = new Map(Array.from(document.getElementsByTagNameNS(namespace, 'Track')).map((track) => [`Timecode:${timecode.index}/Track:${track.getAttribute('index')}`, track]));
  const paths = new Map<string, string>();
  for (const path of trackPaths) {
    const parent = nodes.get(path);
    if (!parent || (parent.parentNode as Element | null)?.localName !== 'Timecode') throw new Error('推杆子轨道父节点不明确');
    const index = available.get(path)!.subtracks.reduce((next, track) => Math.max(next, track.index + 1), 0);
    const subtrack = document.createElementNS(namespace, 'SubTrack');
    subtrack.setAttribute('index', String(index)); subtrack.setAttribute('fader_command', 'Master');
    parent.appendChild(subtrack); paths.set(path, `${path}/SubTrack:${index}`);
  }
  const result = new XMLSerializer().serializeToString(document);
  validateMa2TimecodeWrite(result);
  return { xml: result, paths };
}

/** Create explicit executor tracks, including in a Timecode with no existing tracks. */
export function appendMa2Tracks(xml: string, target: number, additions: readonly { executor: string; executorName: string; muted: boolean }[]): { xml: string; paths: string[] } {
  validateMa2TimecodeWrite(xml);
  const report = inspectMa2TimecodeXml(xml);
  const timecode = report.timecodes[0];
  if (report.timecodes.length !== 1 || timecode?.index !== target - 1) throw new Error('轨道新增目标与 Timecode 不一致');
  if (!['3.3.4', '3.7.0'].includes(report.version)) throw new Error('该 MA2 轨道格式尚未验证');
  for (const track of additions) {
    if (!/^[1-9]\d{0,4}\.[1-9]\d{0,4}$/.test(track.executor)) throw new Error('新增轨道需要明确的执行器页码和编号');
    if (!track.executorName.trim() || track.executorName.length > 512 || /[\u0000-\u001f]/.test(track.executorName)) throw new Error('新增轨道的执行器名称无效');
  }
  if (!additions.length) return { xml, paths: [] };
  const namespace = 'http://schemas.malighting.de/grandma2/xml/MA';
  const document = new DOMParser({ onError: (_level, message) => { throw new Error(`MA2 XML 解析失败：${message}`); } }).parseFromString(xml.replace(/^\uFEFF/, ''), 'application/xml');
  const parent = document.getElementsByTagNameNS(namespace, 'Timecode').item(0);
  if (!parent) throw new Error('MA2 Timecode 节点缺失');
  let index = timecode.tracks.reduce((next, track) => Math.max(next, track.index + 1), 0);
  const paths: string[] = [];
  for (const addition of additions) {
    const track = document.createElementNS(namespace, 'Track');
    track.setAttribute('index', String(index));
    if (!addition.muted) track.setAttribute('active', 'true');
    track.setAttribute('expanded', 'true');
    const object = document.createElementNS(namespace, 'Object');
    object.setAttribute('name', addition.executorName);
    for (const value of ['30', '1', ...addition.executor.split('.')]) {
      const number = document.createElementNS(namespace, 'No');
      number.appendChild(document.createTextNode(value)); object.appendChild(number);
    }
    track.appendChild(object);
    const subtrack = document.createElementNS(namespace, 'SubTrack');
    subtrack.setAttribute('index', '0'); track.appendChild(subtrack);
    parent.appendChild(track);
    paths.push(`Timecode:${timecode.index}/Track:${index++}`);
  }
  const result = new XMLSerializer().serializeToString(document);
  validateMa2TimecodeWrite(result);
  return { xml: result, paths };
}

/** Delete/reorder reviewed native tracks and retain paths for surviving event identities. */
export function removeMa2Tracks(xml: string, target: number, paths: readonly string[], order?: readonly string[]): { xml: string; trackPaths: Map<string, string> } {
  validateMa2TimecodeWrite(xml);
  const report = inspectMa2TimecodeXml(xml);
  const timecode = report.timecodes[0];
  if (report.timecodes.length !== 1 || timecode?.index !== target - 1) throw new Error('轨道删除目标与 Timecode 不一致');
  if (!['3.3.4', '3.7.0'].includes(report.version)) throw new Error('该 MA2 轨道格式尚未验证');
  const prefix = `Timecode:${timecode.index}/Track:`;
  const available = new Set(timecode.tracks.map((track) => `${prefix}${track.index}`));
  if (new Set(paths).size !== paths.length || paths.some((path) => !available.has(path))) throw new Error('轨道删除路径不存在或重复');
  const deleted = new Set(paths);
  const surviving = [...available].filter((path) => !deleted.has(path));
  const sorted = order ?? surviving;
  if (sorted.length !== surviving.length || new Set(sorted).size !== sorted.length || sorted.some((path) => !available.has(path) || deleted.has(path))) throw new Error('轨道顺序必须完整包含剩余轨道');
  const trackPaths = new Map<string, string>();
  if (!paths.length && sorted.every((path, index) => path === surviving[index])) return { xml, trackPaths: new Map([...available].map((path) => [path, path])) };
  const document = new DOMParser({ onError: (_level, message) => { throw new Error(`MA2 XML 解析失败：${message}`); } }).parseFromString(xml.replace(/^\uFEFF/, ''), 'application/xml');
  const tracks = Array.from(document.getElementsByTagNameNS('http://schemas.malighting.de/grandma2/xml/MA', 'Track'));
  const nodes = new Map(tracks.map((track) => [`${prefix}${track.getAttribute('index')}`, track]));
  const slots = [];
  for (const track of tracks) {
    const previous = `${prefix}${track.getAttribute('index')}`;
    const parent = track.parentNode as Element | null;
    if (parent?.localName !== 'Timecode' || !available.has(previous)) throw new Error('MA2 轨道结构不明确');
    const slot = document.createComment('track'); parent.replaceChild(slot, track); slots.push(slot);
  }
  for (const [index, slot] of slots.entries()) {
    const previous = sorted[index]; const track = previous ? nodes.get(previous) : undefined;
    if (!track || !previous) { slot.parentNode!.removeChild(slot); continue; }
    track.setAttribute('index', String(index)); trackPaths.set(previous, `${prefix}${index}`);
    slot.parentNode!.replaceChild(track, slot);
  }
  const result = new XMLSerializer().serializeToString(document);
  validateMa2TimecodeWrite(result);
  return { xml: result, trackPaths };
}
