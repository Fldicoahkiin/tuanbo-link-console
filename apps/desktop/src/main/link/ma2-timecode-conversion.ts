import { randomUUID } from 'node:crypto';
import { withMa2TimeOrigin } from '@tb/core/link';
import { createLightingDocument, ma2TimecodePreviewSchema, type Ma2TimecodePreview, type LightingEvent } from '@tb/schema';
import { extractMa2TimecodeXml, inspectMa2SequenceXml, inspectMa2TimecodeXml, resolveMa2CueReference, validateMa2TimecodeSnapshot, type Ma2SequenceReport } from './ma2-timecode-xml';

export type Ma2TimecodeConversion = Ma2TimecodePreview;

export function convertMa2Snapshot(xml: string, target: number, additionalSequences: readonly number[] = [], timeOriginMs = 0): Ma2TimecodePreview {
  validateMa2TimecodeSnapshot(xml, additionalSequences);
  const hasReferences = inspectMa2TimecodeXml(xml).timecodes.some((tc) => tc.tracks.some((track) => track.subtracks.some((subtrack) => subtrack.events.some((event) => event.cueAddress.length))));
  return convertMa2Timecode(extractMa2TimecodeXml(xml, target), hasReferences || additionalSequences.length ? [xml] : [], target, timeOriginMs);
}

/** Preview conversion only. Keep the entire XML for unsupported data and
 * later read/modify/write; never infer a Cue number from an internal index. */
export function convertMa2Timecode(xml: string, sequenceXml: readonly string[], target: number, timeOriginMs = 0): Ma2TimecodeConversion {
  return convertMa2TimecodeReferences(xml, sequenceXml.map(source => inspectMa2SequenceXml(source, true)), target, timeOriginMs);
}

/** Native object metadata carries the exact Cue index/number mapping without fixture values. */
export function convertMa2TimecodeReferences(xml: string, sequences: readonly Ma2SequenceReport[], target: number, timeOriginMs = 0): Ma2TimecodeConversion {
  const report = inspectMa2TimecodeXml(xml);
  if (!['3.3.4', '3.7.0'].includes(report.version)) throw new Error('这个 MA2 Timecode XML 版本还没验证过');
  if (!Number.isSafeInteger(target) || target < 1) throw new Error('Timecode 编号无效');
  const timecode = report.timecodes.find((entry) => entry.index === target - 1);
  if (!timecode) throw new Error('XML 中没有绑定的 Timecode');
  if (timecode.attributes.frame_format !== '30 FPS') throw new Error('当前仅验证了 30 FPS Timecode 数据转换');
  const rawOffset = timecode.attributes.offset ?? '0';
  if (!/^\d+(?:\.0+)?$/.test(rawOffset) || !Number.isSafeInteger(Number(rawOffset)) || Number(rawOffset) >= 2592000) throw new Error('MA2 偏移必须是完整原生时间单位且小于 24 小时');
  const offsetMs = Number(rawOffset) * 1000 / 30;
  const result: Ma2TimecodeConversion = { target, name: timecode.attributes.name ?? `Timecode ${target}`, readAt: new Date().toISOString(), document: createLightingDocument(), sourceXml: xml, mappings: [], trackMappings: [], cueCatalog: sequences.flatMap((report) => report.sequences.map((entry) => ({ sequence: entry.number, name: entry.name, cues: [...entry.cues].sort((a, b) => a.index - b.index) }))), unconverted: [], warnings: report.warnings };
  for (const track of timecode.tracks) {
    if (track.attributes.active !== undefined && !['true', 'false'].includes(track.attributes.active)) throw new Error('MA2 轨道启用状态格式未验证');
    const trackId = randomUUID(); const clipId = randomUUID();
    const address = track.executorAddress;
    const executor = address.length === 4 && address[0] === '30' && address[1] === '1' && address.slice(2).every((value) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0) ? `${Number(address[2])}.${Number(address[3])}` : null;
    const events: LightingEvent[] = [];
    const path = `Timecode:${timecode.index}/Track:${track.index}`;
    if (executor) result.trackMappings?.push({ trackId, path, executor, subtracks: track.subtracks.map((subtrack) => `${path}/SubTrack:${subtrack.index}`) });
    else if (track.subtracks.every((subtrack) => !subtrack.events.length)) result.unconverted.push({ path, reason: '空轨道执行器引用缺失或结构未验证' });
    for (const subtrack of track.subtracks) for (const event of subtrack.events) {
      try {
        if (!executor) throw new Error('执行器引用缺失或结构未验证');
        if (subtrack.attributes.fader_command !== undefined || event.attributes.fader_level !== undefined) {
          if (report.version !== '3.3.4' || subtrack.attributes.fader_command !== 'Master') throw new Error('该原生推杆类型或版本还没验证过');
          if (Object.keys(subtrack.attributes).some((name) => !['index', 'fader_command'].includes(name)) || Object.keys(event.attributes).some((name) => !['index', 'time', 'fader_level'].includes(name)) || event.cueAddress.length || event.cueName !== null) throw new Error('推杆点包含未验证参数，保留原始 XML');
          const rawLevel = event.attributes.fader_level;
          const rawTime = event.attributes.time ?? '0';
          if (rawLevel === undefined || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(rawLevel) || !/^\d+(?:\.\d+)?$/.test(rawTime) || !Number.isFinite(Number(rawTime))) throw new Error('推杆比例或时间无效');
          const id = randomUUID();
          events.push({ id, kind: 'ma2-fader', at: Number(rawTime) * 1000 / 30, executor, fader: 'Master', level: Number(rawLevel), label: '主推杆' });
          result.mappings.push({ eventId: id, trackId, clipId, path: event.path, sequence: null, cueIndex: null, executor, action: 'master' });
          continue;
        }
        if (!['Goto', 'Go', 'Off'].includes(event.attributes.command ?? '') || event.attributes.pressed !== 'true') throw new Error('该动作或按键释放事件还没完成转换验证');
        if (Object.keys(event.attributes).some((name) => !['index', 'time', 'command', 'pressed', 'step'].includes(name))) throw new Error('事件含额外动作参数，保留原始 XML 等待转换');
        const rawTime = event.attributes.time ?? '0';
        if (!/^\d+(?:\.\d+)?$/.test(rawTime) || !Number.isFinite(Number(rawTime))) throw new Error('事件时间无效');
        if (event.attributes.command === 'Go' || event.attributes.command === 'Off') {
          if (event.cueAddress.length || event.cueName !== null) throw new Error('执行器动作含未验证的 Cue 引用');
          const action = event.attributes.command === 'Go' ? 'go' : 'off';
          const id = randomUUID();
          events.push({ id, kind: 'ma2', at: Number(rawTime) * 1000 / 30, executor, action, label: action === 'go' ? '下一步' : '关闭执行器' });
          result.mappings.push({ eventId: id, trackId, clipId, path: event.path, sequence: null, cueIndex: null, executor, action });
          continue;
        }
        const reference = resolveMa2CueReference(event.cueAddress, sequences);
        const id = randomUUID();
        events.push({ id, kind: 'ma2', at: Number(rawTime) * 1000 / 30, sequence: reference.sequence, cue: reference.cueNumber, label: reference.cueName ?? event.cueName ?? `Cue ${reference.cueNumber}`, executor, action: 'goto' });
        result.mappings.push({ eventId: id, trackId, clipId, path: event.path, sequence: reference.sequence, cueIndex: reference.cueIndex, executor });
      } catch (error) {
        result.unconverted.push({ path: event.path, reason: error instanceof Error ? error.message : String(error) });
        // A read-only projection is not permission to execute or rewrite this event.
        // Retain the unknown parameters in sourceXml and block the entire binding's write path.
        const rawTime = event.attributes.time;
        if (executor && rawTime !== undefined && /^\d+(?:\.\d+)?$/.test(rawTime) && Number.isFinite(Number(rawTime)) && event.attributes.command === 'Goto' && event.attributes.pressed === 'true') {
          try {
            const reference = resolveMa2CueReference(event.cueAddress, sequences);
            const id = randomUUID();
            events.push({ id, kind: 'ma2', at: Number(rawTime) * 1000 / 30, sequence: reference.sequence, cue: reference.cueNumber, label: reference.cueName ?? event.cueName ?? `Cue ${reference.cueNumber}`, executor, action: 'goto' });
            result.mappings.push({ eventId: id, trackId, clipId, path: event.path, sequence: reference.sequence, cueIndex: reference.cueIndex, executor });
          } catch (referenceError) { result.warnings.push(`${event.path}：${referenceError instanceof Error ? referenceError.message : String(referenceError)}`); }
        }
      }
    }
    result.document.tracks.push({ id: trackId, name: track.executorName ?? `MA2 轨道 ${track.index + 1}`, kind: 'ma2', color: '#ba8fff', group: '', muted: track.attributes.active !== 'true', solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: clipId, name: timecode.attributes.name ?? `Timecode ${target}`, start: 0, duration: events.reduce((end, event) => Math.max(end, event.at + 1), 1), timeLock: 'time', muted: false, events }] });
  }
  for (const track of result.document.tracks) for (const clip of track.clips) {
    for (const event of clip.events) event.at += offsetMs;
    clip.duration += offsetMs;
  }
  const nativeTimes = timecode.tracks.flatMap(track => track.subtracks.flatMap(subtrack => subtrack.events.map(event => event.attributes.time ?? '0')));
  if (nativeTimes.some(time => !/^\d+(?:\.\d+)?$/.test(time) || !Number.isFinite(Number(time)))) throw new Error('控台事件的时间无效，原样保留，但无法确认它在歌曲里的位置');
  result.timing = { frameFormat: '30 FPS', unit: 'frames-30', offsetNative: rawOffset, absoluteEventTimesMs: nativeTimes.map(time => (Number(time) + Number(rawOffset)) * 1000 / 30) };
  return withMa2TimeOrigin(ma2TimecodePreviewSchema.parse(result), timeOriginMs);
}
