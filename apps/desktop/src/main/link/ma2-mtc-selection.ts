import { randomBytes } from 'node:crypto';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { z } from 'zod';
import { holdForShow, isShowWait, ma2MtcRange, ma2MtcSelectionCommand, ma2MtcSelections, ma2SelectorTrackProblem, MA2_SONG_TIMECODE_SLOT, type ShowGateReader } from '@tb/core/link';
import { ma2ObjectDirectorySchema, ma2TimecodeRangesSchema, type Ma2SelectorTrackConflict, type Ma2NetworkTarget, type Ma2CatalogRequest, type Ma2TimecodeRanges, type Ma2ReadProgressUpdate } from '@tb/schema';
import type { Ma2Telnet } from './ma2-telnet';
import { ma2SequenceGoResultSchema, waitForMa2Admission, type Ma2OnpcBridge } from './ma2-onpc-bridge';
import { verifyMa2ShowSource, type Ma2ShowSource } from './ma2-show-probe';
import type { Ma2ConsoleBackups } from './ma2-console-backups';
import { ma2ExchangePath, ma2LuaString, runMa2GuardedLua } from './ma2-lua-command';
import { createMa2TimecodeXml } from './ma2-create';
import { ma2SongTimecodeXml } from './ma2-song-timecode';
import { repairMa2SelectorExecutor } from './ma2-selector-executor';
import { assignMa2SongExecutor, planMa2SongExecutor } from './ma2-song-executor';
import { ma2TrackPlaybackMuted, emptyMa2SequenceXml, inspectMa2SequenceXml, inspectMa2TimecodeXml, referencedMa2Sequences, sameMa2XmlObjects, ma2MtcPlaybackSettings } from './ma2-timecode-xml';

export const MA2_MTC_SELECTOR_MARK = 'TBLINK_MTC_SELECTOR_V1';
const selectorName = 'TBLINK_MTC_SELECTION';
const namespace = 'http://schemas.malighting.de/grandma2/xml/MA';
const parse = (xml: string) => new DOMParser({ onError: (_level, message) => { throw new Error(`控台选曲数据无效：${message}`); } }).parseFromString(xml.replace(/^\uFEFF/, ''), 'application/xml');

export function ma2MtcSelectorSequence(number: number, version: string, commands: readonly string[]): string {
  const document = parse(emptyMa2SequenceXml(number, version));
  const sequence = document.getElementsByTagName('Sequ').item(0)!;
  sequence.setAttribute('name', selectorName);
  for (const cue of Array.from(sequence.getElementsByTagName('Cue'))) sequence.removeChild(cue);
  const empty = document.createElementNS(namespace, 'Cue'); empty.setAttribute('xsi:nil', 'true'); sequence.appendChild(empty);
  const infos = document.createElementNS(namespace, 'InfoItems'), info = document.createElementNS(namespace, 'Info');
  info.appendChild(document.createTextNode(MA2_MTC_SELECTOR_MARK)); infos.appendChild(info); sequence.appendChild(infos);
  for (const [index, command] of commands.entries()) {
    const cue = document.createElementNS(namespace, 'Cue'); cue.setAttribute('index', String(index + 1));
    const label = document.createElementNS(namespace, 'Number'); label.setAttribute('number', String(index + 1)); label.setAttribute('sub_number', '0'); cue.appendChild(label);
    const part = document.createElementNS(namespace, 'CuePart'); part.setAttribute('index', '0');
    const text = document.createElementNS(namespace, 'macro_text'); text.appendChild(document.createTextNode(command)); part.appendChild(text); cue.appendChild(part); sequence.appendChild(cue);
  }
  return new XMLSerializer().serializeToString(document);
}

/** Selector XML repeats the same tags and list of Timecode numbers in almost every Cue.
 * Expand those bytes on the console before the existing full comparison or file write. */
export function ma2SelectorXmlLiteral(xml: string): string {
  const plain = ma2LuaString(xml);
  if (xml.length < 4096 || xml.includes('\0')) return plain;
  const tokens = xml.split(/(<[^>]+>|(?: \+ \d+){1,8}|\s+)/u);
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  const dictionary = [...counts].filter(([token, count]) => count > 1 && (token.length - 2) * (count - 1) > 12)
    .sort(([left, a], [right, b]) => right.length * b - left.length * a).slice(0, 255).map(([token]) => token);
  const codes = new Map(dictionary.map((token, index) => [token, Buffer.from([0, index + 1])]));
  const packed = Buffer.concat(tokens.map(token => codes.get(token) ?? Buffer.from(token)));
  const compact = `(function()local d={${dictionary.map(ma2LuaString).join(',')}};return (unhex('${packed.toString('hex')}'):gsub('%z(.)',function(k)return d[string.byte(k)] end)) end)()`;
  return compact.length < plain.length ? compact : plain;
}

export function ma2MtcSelectorCommands(xml: string): string[] {
  const sequence = inspectMa2SequenceXml(xml).sequences[0];
  const native = parse(xml).getElementsByTagName('Sequ').item(0);
  const allowed = new Set(['InfoItems', 'Info', 'Cue', 'Number', 'CuePart', 'macro_text', 'CuePartPresetTiming', 'PresetTiming']);
  if (!sequence || sequence.name !== selectorName || !native || Array.from(native.getElementsByTagName('*')).some(node => !allowed.has(node.tagName))) throw new Error('控台选曲序列包含其他内容，没有覆盖，请检查控台');
  const cues = Array.from(native.getElementsByTagName('Cue')).filter(cue => cue.getElementsByTagName('Number').length);
  if (cues.some((cue, index) => Number(cue.getElementsByTagName('Number').item(0)?.getAttribute('number')) !== index + 1
    || Number(cue.getElementsByTagName('Number').item(0)?.getAttribute('sub_number')) !== 0
    || Array.from(cue.attributes).some(attribute => attribute.name !== 'index')
    || cue.getElementsByTagName('macro_text').length !== 1
    || Array.from(cue.getElementsByTagName('CuePart')).some(part => Array.from(part.attributes).some(attribute => attribute.name !== 'index'))
    || Array.from(cue.getElementsByTagName('PresetTiming')).some(timing => timing.attributes.length))) throw new Error('控台选曲序列的步骤被修改，没有覆盖，请检查控台');
  const commands = cues.map(cue => cue.getElementsByTagName('macro_text').item(0)!.textContent ?? '');
  if (commands.some(command => !/^(?:Off Timecode \d+(?: \+ \d+)*(?:; Go Timecode \d+)?|Go Timecode \d+)$/.test(command))) throw new Error('控台选曲序列包含其他指令，没有覆盖，请检查控台');
  return commands;
}

/** Timecode owns the Cue times. A copied Time/Follow trigger must not advance the sequence early. */
export function ma2MtcSequenceSettings(xml: string): { xml: string; cues: string[] } {
  const report = inspectMa2SequenceXml(xml);
  if (!/<Trigger\b/.test(xml)) return { xml, cues: [] };
  const document = parse(xml);
  const changed: string[] = [];
  for (const cue of Array.from(document.getElementsByTagName('Cue'))) {
    const triggers = Array.from(cue.getElementsByTagName('Trigger')).filter(trigger => trigger.parentNode === cue);
    if (!triggers.some(trigger => trigger.getAttribute('type') !== 'Go')) continue;
    const index = Number(cue.getAttribute('index'));
    const number = report.sequences[0]!.cues.find(value => value.index === index)?.number;
    if (!number) throw new Error('控台歌曲的触发步骤无法确认，没有修改');
    changed.push(number);
    for (const trigger of triggers) cue.removeChild(trigger);
  }
  return { xml: changed.length ? new XMLSerializer().serializeToString(document) : xml, cues: changed };
}

export type Ma2MtcPreparationTask = { muteSelectorTrack?: Ma2SelectorTrackConflict | undefined; selectorTriggerTarget?: number | undefined; selectorCommandTarget?: number | undefined; selectorSettingsTarget?: number | undefined; checkCurrentSong?: (() => Promise<boolean>) | undefined; songSettingsTargets?: readonly number[] | undefined; songTriggerTargets?: readonly number[] | undefined; expectedSource?: Ma2ShowSource | undefined; report?: ((progress: Ma2ReadProgressUpdate) => void) | undefined; signal?: AbortSignal | undefined; onConsoleCheck?: (mayWrite?: boolean) => void };
type Bridge = Pick<Ma2OnpcBridge, 'request' | 'exchange'>;
type Connection = Pick<Ma2Telnet, 'command'>;
export type Ma2ConfirmedTimecode = { number: number; xml: string; previousXml?: string; show: string; generation: string; goSequences?: readonly number[] };
const timecodeRange = (target: number, xml: string): Ma2TimecodeRanges['entries'][number] => {
  const tc = inspectMa2TimecodeXml(xml).timecodes[0]!;
  const events = tc.tracks.flatMap(track => track.subtracks.flatMap(subtrack => subtrack.events));
  const last = events.length ? events.reduce((max, event) => Math.max(max, Number(event.attributes.time ?? 0)), 0) : null;
  return { target, name: tc.attributes.name ?? '', offset: tc.attributes.offset ?? '0', length: tc.attributes.lenght ?? '',
    slot: tc.attributes.slot ?? '', frame: tc.attributes.frame_format ?? '', last: last === null ? '' : String(last) };
};
function samePlaybackRange(a: Ma2TimecodeRanges['entries'][number], b: Ma2TimecodeRanges['entries'][number]): boolean {
  return a.target === b.target && Number(a.offset) === Number(b.offset) && Number(a.length || 0) === Number(b.length || 0) && a.slot === b.slot && a.last === b.last;
}
const selectionPoints = (entries: Ma2TimecodeRanges['entries'], afterRollSeconds?: number) => ma2MtcSelections(entries.filter(entry => !entry.internal && entry.slot === MA2_SONG_TIMECODE_SLOT && entry.last !== '').map(ma2MtcRange), afterRollSeconds);
/** Compare both ends of the current song with the actual Goto events and the commands in their native Cues. */
export function matchesMa2MtcSongSelection(ranges: Ma2TimecodeRanges, targets: readonly number[], timecodeXml: string, sequenceXml: string, playback?: Ma2CatalogRequest['songPlayback']): boolean {
  const selector = ranges.selectorReady;
  const timeline = inspectMa2TimecodeXml(timecodeXml).timecodes[0];
  const track = timeline?.tracks[0];
  if (!selector || !timeline || timeline.index + 1 !== selector || timeline.tracks.length !== 1
    || !track || ma2TrackPlaybackMuted(track.attributes) || track.subtracks.length !== 1) return false;
  const header = timeline.attributes;
  if (header.slot !== MA2_SONG_TIMECODE_SLOT || Number(header.offset ?? 0) !== 0 || header.m_autostart !== 'true'
    || header.no_status_call !== undefined || header.no_switch_off !== undefined || Number(header.user_bits ?? 0) !== 0) return false;
  const commands = ma2MtcSelectorCommands(sequenceXml);
  const events = track.subtracks[0]!.events.map(event => {
    const step = Number(event.attributes.step);
    const linked = event.attributes.command === 'Goto' && event.attributes.pressed === 'true'
      && event.cueAddress.join('.') === `1.${selector}.${step}`;
    return { at: Number(event.attributes.time ?? 0), step, command: linked ? commands[step - 1] : undefined };
  }).sort((left, right) => left.at - right.at);
  const inSlot = ranges.entries.filter(entry => !entry.internal && entry.slot === MA2_SONG_TIMECODE_SLOT);
  const numbers = inSlot.map(entry => entry.target);
  const songs = inSlot.filter(entry => entry.last !== '').map(ma2MtcRange);
  // The selector is saved in the Show and can run with the desktop closed. A step for a
  // removed song, a previous start, or a number now used on another slot can still fire.
  const starts = new Map(songs.map(song => [song.timecode, song.start]));
  const ends = new Set([0, ...songs.map(song => song.end)]);
  const ownedNumbers = new Set(numbers);
  if (new Set(events.map(event => event.step)).size !== commands.length) return false;
  for (const [index, event] of events.entries()) {
    if (events[index - 1]?.at === event.at) return false;
    if (!event.command) return false;
    const go = /Go Timecode (\d+)$/.exec(event.command);
    if (go ? starts.get(Number(go[1])) !== event.at : !ends.has(event.at)) return false;
    if (event.command.match(/\d+/g)?.some(number => !ownedNumbers.has(Number(number)))) return false;
  }
  // Status Call recalls the last selector event even when the music starts in a gap.
  if (playback && playback.durationMs > 0) {
    const start = Math.round(playback.startMs * 30 / 1000);
    const entry = inSlot.find(candidate => targets.includes(candidate.target) && Number(candidate.offset) === start);
    if (entry) {
      const quietStart = entry.last === '' ? start : ma2MtcRange(entry).end;
      const musicEnd = start + Math.ceil(playback.durationMs * 30 / 1000);
      if (quietStart < musicEnd) {
        const off = ma2MtcSelectionCommand(numbers, null);
        const previous = events.filter(event => event.at <= quietStart).at(-1);
        if (previous?.command !== off || events.some(event => event.at > quietStart && event.at < musicEnd && event.command !== off)) return false;
      }
    }
  }
  const cleared = inSlot.filter(entry => entry.last === '' && targets.includes(entry.target));
  if (cleared.some(entry => events.some(event => event.command?.endsWith(`Go Timecode ${entry.target}`)))) return false;
  return songs.filter(song => targets.includes(song.timecode)).every(song => {
    const interval = events.filter(event => event.at >= song.start && event.at <= song.end);
    const next = songs.find(other => other.start === song.end);
    return interval.length === 2 && interval[0]!.at === song.start && interval[1]!.at === song.end
      && interval[0]!.command === ma2MtcSelectionCommand(numbers, song.timecode)
      && interval[1]!.command === ma2MtcSelectionCommand(numbers, next?.timecode ?? null);
  });
}

class Ma2SelectionRangesChanged extends Error {
  constructor(readonly source: Ma2ShowSource, readonly changed: boolean) {
    super('控台歌曲的时间范围在核对期间再次变化，请等修改结束后同步当前节目');
  }
}

const positionSchema = z.object({ number: z.number().int().min(1).max(99999), exists: z.boolean() }).strict();

/**
 * The sole compiler/installer of the console's MTC song selector. Runs only while editing/syncing.
 * The selector itself is native MA2 Timecode + empty command Cues: playback, seeking and P1 need no network or Lua loop.
 */
export class Ma2MtcSelectionService {
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private prepared: string | null = null;
  private knownRanges: { show: string; generation: string; entries: Ma2TimecodeRanges['entries'] } | null = null;
  constructor(private readonly show: ShowGateReader, private readonly backups: Pick<Ma2ConsoleBackups, 'record'>) {}
  invalidate(): void { this.prepared = null; this.knownRanges = null; }
  prepare(connection: Connection, bridge: Bridge, network: Ma2NetworkTarget, force = false, targets: readonly number[] = [], verifiedSequence?: { number: number; xml: string }, verifiedTimecode?: Ma2ConfirmedTimecode, task?: Ma2MtcPreparationTask): Promise<boolean> {
    const queued = this.pending > 0;
    this.pending++;
    // A preparation ahead of this one may change the exact same Sequence or
    // Timecode. Still require the caller's original Show, but read the objects again.
    const work = this.queue.then(async () => {
      try {
        return await this.install(connection, bridge, network, force, targets, verifiedSequence, verifiedTimecode, task, queued);
      } catch (error) {
        if (!(error instanceof Ma2SelectionRangesChanged)) throw error;
        // The desk acknowledged the earlier writes and now contains a different arrangement.
        // Plan from those new ranges once. Never replay an uncertain write or follow a new Show.
        task?.report?.({ phase: 'selection', completed: 0, total: 0, detail: '控台歌曲的起点或终点有变化，正在按新位置核对选曲' });
        return this.install(connection, bridge, network, true, targets, undefined, undefined, { ...task, expectedSource: error.source }, true, error.changed);
      }
    }).finally(() => { this.pending--; });
    // Each caller receives its own failure. Releasing the queue is not a retry of that operation.
    this.queue = work.then(() => undefined, () => undefined);
    return work;
  }
  private async install(connection: Connection, sourceBridge: Bridge, network: Ma2NetworkTarget, force: boolean, targets: readonly number[], verifiedSequence?: { number: number; xml: string }, expectedTimecode?: Ma2ConfirmedTimecode, task?: Ma2MtcPreparationTask, queued = false, previouslyChanged = false): Promise<boolean> {
    const endpoint = `${network.host}:${network.port}`;
    if (!force && !targets.length && !task?.muteSelectorTrack && !task?.songSettingsTargets?.length && !task?.songTriggerTargets?.length && !task?.selectorCommandTarget && !task?.selectorSettingsTarget && this.prepared === endpoint) return false;
    let completed = 0, total = 0, detail = '正在读取控台时间线目录，检查歌曲怎样按时间码启动';
    const report = (message = detail) => task?.report?.({ phase: 'selection', completed, total, detail: message.slice(0, 128) });
    const stage = (message: string) => { detail = message; report(); };
    const gate = () => { task?.signal?.throwIfAborted(); holdForShow(this.show, 'ma2.sync.write'); };
    let directorySource: Ma2ShowSource | undefined;
    const bridge: Bridge = {
      request: async (...args) => (await bridge.exchange(...args)).response,
      exchange: async (operation, target, expected = '', desired = '', signal, progress, behind) => {
        gate();
        const operationName = operation === 'SEQGO' ? `检查序列 ${target} 的触发方式` : operation === 'READ' ? `读取时间线 ${target}` : detail;
        let steps = 0;
        report(operationName);
        const activeSignal = task?.signal ?? signal;
        const submit = () => sourceBridge.exchange(operation, target, expected, desired, activeSignal, download => {
          steps += 1;
          report(download ? `${operationName} · 已收到 ${download.completed} / ${download.total} 字节` : `${operationName} · 控台已完成 ${steps} 步`);
          progress?.(download);
        }, behind, directorySource);
        try {
          return await waitForMa2Admission(submit, async () => {
            gate();
            if (directorySource) await verifyMa2ShowSource(connection, directorySource);
            gate();
          }, activeSignal);
        }
        catch (error) { if (isShowWait(error) || task?.signal?.aborted) throw error; throw new Error(`${operationName}未完成：${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      }
    };
    const writeSongSettings = async (target: number, current: string, desired: string) => {
      const receipt = await bridge.exchange('APPLY', target, current, desired);
      await this.backups.record(bridge, { console: endpoint, object: `Timecode ${target}`, files: [`tblink_backup_${receipt.requestId}`] });
      return receipt.response;
    };
    const prepareTriggers = async (sequence: number, source: Ma2ShowSource, boundTimecode?: number | 'selector') => {
      const identity = `${Buffer.from(source.show).toString('hex')}\n${Buffer.from(source.generation).toString('hex')}`;
      const readback = await bridge.exchange('SEQGO', sequence, boundTimecode === undefined ? identity : `${identity}\n${boundTimecode}`);
      const result = ma2SequenceGoResultSchema.parse(JSON.parse(readback.response));
      if (result.changed) await this.backups.record(bridge, { console: endpoint, object: `Sequence ${sequence}`, files: [`tblink_library_${readback.requestId}`] });
      return result.changed;
    };
    const restoreSelectorPlayback = async (source: Ma2ShowSource, number: number) => {
      const backup = await repairMa2SelectorExecutor(connection, source, number, MA2_MTC_SELECTOR_MARK, gate);
      if (backup) await this.backups.record(bridge, { console: endpoint, object: `Executor ${backup.address}`, files: [backup.file] });
      return Boolean(backup);
    };
    report();
    let changed = previouslyChanged;
    const known = !force && this.prepared === endpoint ? this.knownRanges : null;
    task?.signal?.throwIfAborted();
    try {
      if (task?.muteSelectorTrack) {
        const target = task.muteSelectorTrack;
        directorySource = task.expectedSource;
        if (!directorySource) throw new Error('请先核对当前节目所在的控台 Show');
        await verifyMa2ShowSource(connection, directorySource);
        const current = await bridge.request('READ', target.timecode);
        const document = parse(current);
        const timeline = inspectMa2TimecodeXml(current).timecodes;
        const matches = timeline[0]?.tracks.filter(track => track.index + 1 === target.track);
        const track = matches?.[0];
        if (timeline.length !== 1 || timeline[0]?.index !== target.timecode - 1 || matches?.length !== 1 || !track
          || track.executorAddress.join('.') !== `30.1.${target.executor}` || !track.subtracks.some(sub => sub.events.length)
          || Array.from(document.getElementsByTagName('Info')).some(node => node.textContent === MA2_MTC_SELECTOR_MARK)) {
          throw new Error('这条控台轨道的用途已经改变，请重新核对当前节目');
        }
        const playMode = timeline[0].attributes.play_mode;
        if (playMode && playMode !== 'Stop') throw new Error(`请先在控台停止 Timecode ${target.timecode}，再关闭第 ${target.track} 轨的播放`);
        const checkRoute = async () => {
          const ranges = ma2TimecodeRangesSchema.parse(JSON.parse(await bridge.request('TCRANGES', 1, 'editing')));
          if (ranges.show !== directorySource?.show || ranges.generation !== directorySource.generation) throw new Error('控台 Show 已切换，请重新核对当前节目');
          const conflict = ranges.selectorTrackConflict;
          return conflict?.timecode === target.timecode && conflict.track === target.track && conflict.executor === target.executor;
        };
        const conflict = await checkRoute();
        if (!conflict && ma2TrackPlaybackMuted(track.attributes)) return false;
        if (!conflict) throw new Error('选曲执行器或冲突轨道已改变，请重新核对当前节目');
        const native = Array.from(document.getElementsByTagName('Track')).find(node => Number(node.getAttribute('index') ?? 0) === track.index)!;
        native.setAttribute('muted', 'true');
        const desired = new XMLSerializer().serializeToString(document);
        this.invalidate();
        const confirmed = await writeSongSettings(target.timecode, current, desired);
        if (!sameMa2XmlObjects(confirmed, desired) || await checkRoute()) throw new Error('控台还没有确认关闭这条轨道的播放，请重新核对当前节目');
        return true;
      }
      // Manual sync verified this song's actual selector commands and track assignment.
      // Repair only the identified playback settings, then let the caller verify the route again.
      if (task?.songSettingsTargets?.length || task?.songTriggerTargets?.length || task?.selectorSettingsTarget || task?.selectorCommandTarget || task?.selectorTriggerTarget) {
        directorySource = task.expectedSource;
        if (!directorySource) throw new Error('请先核对当前节目所在的控台 Show');
        const numbers = new Set([...(task.songSettingsTargets ?? []), ...(task.songTriggerTargets ?? [])]);
        const checkedSequences = new Set<number>();
        if (task.selectorSettingsTarget) numbers.add(task.selectorSettingsTarget);
        if (task.selectorCommandTarget) numbers.add(task.selectorCommandTarget);
        if (task.selectorTriggerTarget) numbers.add(task.selectorTriggerTarget);
        for (const number of numbers) {
          gate();
          await verifyMa2ShowSource(connection, directorySource);
          const current = await bridge.request('READ', number);
          const timeline = inspectMa2TimecodeXml(current).timecodes[0];
          const selector = number === task.selectorSettingsTarget || number === task.selectorCommandTarget || number === task.selectorTriggerTarget;
          const marked = Array.from(parse(current).getElementsByTagName('Info')).some(info => info.textContent === MA2_MTC_SELECTOR_MARK);
          if (timeline?.index !== number - 1 || timeline.attributes.slot !== MA2_SONG_TIMECODE_SLOT || marked !== selector
            || (selector && (timeline.attributes.name !== selectorName || timeline.tracks.length !== 1))) {
            throw new Error(`Timecode ${number} 的用途或时码槽已变，请重新核对当前节目`);
          }
          if (number === task.selectorTriggerTarget && await prepareTriggers(number, directorySource, 'selector')) changed = true;
          if (number === task.selectorCommandTarget && await restoreSelectorPlayback(directorySource, number)) changed = true;
          if (!selector && task.songTriggerTargets?.includes(number)) {
            for (const sequence of referencedMa2Sequences(current)) {
              if (checkedSequences.has(sequence)) continue;
              checkedSequences.add(sequence);
              if (await prepareTriggers(sequence, directorySource, number)) changed = true;
            }
          }
          const desired = ma2MtcPlaybackSettings(current, selector);
          if (sameMa2XmlObjects(current, desired)) continue;
          await verifyMa2ShowSource(connection, directorySource);
          const confirmed = await writeSongSettings(number, current, desired);
          if (!sameMa2XmlObjects(confirmed, desired)) throw new Error(`Timecode ${number} 的播放设置没有得到控台确认，请再同步一次`);
          changed = true;
        }
        await verifyMa2ShowSource(connection, directorySource);
        return changed;
      }
      const verifiedTimecode = queued ? undefined : expectedTimecode;
      const goSequences = new Set(verifiedTimecode?.goSequences);
      if (!queued && verifiedSequence && !ma2MtcSequenceSettings(verifiedSequence.xml).cues.length) goSequences.add(verifiedSequence.number);
      // A point moved inside the same song interval does not change the native selector. Use the
      // Timecode this sync actually read back, so moving the end, muting all points or changing the
      // MTC origin still rebuilds selection even when the Sequence itself was not edited.
      if (known && verifiedTimecode && known.show === verifiedTimecode.show && known.generation === verifiedTimecode.generation
        && targets.length === 1 && targets[0] === verifiedTimecode.number) {
        const fresh = timecodeRange(verifiedTimecode.number, verifiedTimecode.xml);
        const previous = known.entries.find(entry => entry.target === fresh.target);
        if (previous && previous.slot === fresh.slot) {
          const entries = known.entries.map(entry => entry.target === fresh.target ? fresh : entry);
          // The selector only owns Slot 2. Moving a Cue on a different slot cannot affect it.
          if (fresh.slot !== MA2_SONG_TIMECODE_SLOT || (
            referencedMa2Sequences(verifiedTimecode.xml).every(number => goSequences.has(number))
            && sameMa2XmlObjects(verifiedTimecode.xml, ma2MtcPlaybackSettings(verifiedTimecode.xml, false))
            && (fresh.last === '' && previous.last === '' || fresh.last !== '' && previous.last !== '' && Number(fresh.offset) === Number(previous.offset) && ma2MtcRange(fresh).end === ma2MtcRange(previous).end))) {
            this.knownRanges = { ...known, entries }; this.prepared = endpoint; return false;
          }
        }
      }
      // A console-side track edit may be the first edit after connection. Verify the
      // actual song route before touching selection data belonging to other songs.
      if (!known && !force && task?.checkCurrentSong && verifiedTimecode?.previousXml && targets.length === 1 && targets[0] === verifiedTimecode.number) {
        const fresh = timecodeRange(verifiedTimecode.number, verifiedTimecode.xml);
        const previous = timecodeRange(verifiedTimecode.number, verifiedTimecode.previousXml);
        if (fresh.slot === MA2_SONG_TIMECODE_SLOT && fresh.last !== '' && samePlaybackRange(previous, fresh)
          && referencedMa2Sequences(verifiedTimecode.xml).every(number => goSequences.has(number))
          && sameMa2XmlObjects(verifiedTimecode.xml, ma2MtcPlaybackSettings(verifiedTimecode.xml, false))) {
          gate();
          if (await task.checkCurrentSong()) {
            task.onConsoleCheck?.(false);
            return false;
          }
        }
      }
      gate();
      this.invalidate();
      task?.onConsoleCheck?.();
      const source = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST', 1)));
      if (expectedTimecode && (expectedTimecode.show !== source.show || expectedTimecode.generation !== source.generation)) throw new Error('控台 Show 或连接已切换，没有确认选曲');
      const expectedSource = task?.expectedSource;
      if (expectedSource && (source.show !== expectedSource.show || source.generation !== expectedSource.generation || source.version !== expectedSource.version)) throw new Error('控台 Show 或连接已切换，没有修改选曲设置');
      directorySource = source;
      stage(`正在核对 ${source.entries.length} 条时间线的起止位置`);
      // Rebuilding selection affects every song. The operator may have moved another
      // Timecode on the desk since the last sync, even on the same Show and connection.
      const ranges = ma2TimecodeRangesSchema.parse(JSON.parse(await bridge.request('TCRANGES', 1, 'editing')));
      if (ranges.selectorTrackConflict) throw new Error(ma2SelectorTrackProblem(ranges.selectorTrackConflict));
      const previousRanges = known && known.show === source.show && known.generation === source.generation
        ? new Map(known.entries.map(entry => [entry.target, entry])) : null;
      if (source.show !== ranges.show || (ranges.generation && ranges.generation !== source.generation)) throw new Error('控台 Show 已切换，没有准备选曲');
      const guard = `assert(gma.show.getvar('SHOWFILE')==${ma2LuaString(source.show)} and TBLINK_BRIDGE_GENERATION==${ma2LuaString(source.generation)},'Show or session changed');`;
      const run = (body: string) => runMa2GuardedLua(connection, guard + body, gate);
      // Marker belongs to the native Show, so another computer reuses the same selector.
      stage('正在查找控台上负责按时间码选歌的序列');
      const markers = new Set<number>();
      for (const kind of ['LISTSEQ', 'LIST'] as const) {
        const directory = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request(kind, 1, 'selector')));
        if (directory.show !== source.show || directory.generation !== source.generation || directory.version !== source.version) throw new Error('控台 Show 或连接已切换，没有确认选曲');
        for (const entry of directory.entries) {
          if (!entry.internal) throw new Error('控台选曲对象的标记无法确认');
          markers.add(entry.target);
        }
      }
      if (markers.size > 1) throw new Error('控台上有多组选曲对象，请核对后再连接');
      const owned = [...markers][0] ?? 0;
      const candidates = ranges.entries.filter(entry => entry.target !== owned && entry.slot === MA2_SONG_TIMECODE_SLOT);
      if (!candidates.some(entry => entry.last !== '') && !owned) {
        this.knownRanges = { show: source.show, generation: source.generation, entries: ranges.entries.filter(entry => !entry.internal) };
        this.prepared = endpoint; return false;
      }
      const points = selectionPoints(candidates, ranges.afterRollSeconds), numbers = candidates.map(entry => entry.target);
      const commands = points.map(point => numbers.length ? ma2MtcSelectionCommand(numbers, point.timecode) : `Off Timecode ${owned}`);
      const position = positionSchema.parse(JSON.parse(await run(`local o=gma.show.getobj;local n=${owned};local exists=n>0 and o.handle('Sequence '..n)~=nil;if exists then assert(o.label(o.handle('Sequence '..n))=='${selectorName}','Selector sequence changed') elseif n==0 then for i=9900,99999 do if not o.handle('Sequence '..i) and not o.handle('Timecode '..i) then n=i;break end end;assert(n>0,'No free selector object') end;return '{"number":'..n..',"exists":'..tostring(exists)..'}'`)));
      const context = { network, expectedSource: { show: source.show, generation: source.generation, version: source.version } };
      const desiredSequence = ma2MtcSelectorSequence(position.number, source.version, commands);
      let currentSequence: string | null = null;
      if (position.exists) {
        currentSequence = await bridge.request('SEQUENCE', position.number);
        if (currentSequence.includes('<Trigger')) {
          const manual = ma2MtcSequenceSettings(currentSequence);
          ma2MtcSelectorCommands(manual.xml);
          if (manual.cues.length) {
            if (await prepareTriggers(position.number, source, 'selector')) changed = true;
            currentSequence = await bridge.request('SEQUENCE', position.number);
          }
        }
      }
      const sequenceChanged = !currentSequence || JSON.stringify(ma2MtcSelectorCommands(currentSequence)) !== JSON.stringify(commands);
      if (sequenceChanged) {
        stage(`正在更新并核对控台选曲指令，共 ${commands.length} 条`);
        changed = true;
        const file = `tblink_library_${randomBytes(16).toString('hex')}`;
        const check = currentSequence === null ? `assert(not gma.show.getobj.handle('Sequence ${position.number}'),'Selector position occupied');`
          : `local h=gma.show.getobj.handle('Sequence ${position.number}');assert(h and gma.show.property.get(h,'Info')=='${MA2_MTC_SELECTOR_MARK}','Selector ownership changed');gma.cmd('Export Sequence ${position.number} ${file} /o'..${ma2ExchangePath});assert(canonical(read('${file}'))==canonical(${ma2SelectorXmlLiteral(currentSequence)}),'Selector changed during write');`;
        const read = `local p=gma.show.getvar('PATH')..'/importexport/';local function read(n)local f=assert(io.open(p..n..'.xml','rb'));local s=f:read('*a');f:close();return s end;local function canonical(s)return s:gsub('<Info[^>]*/>',''):gsub('>[%s]+<','><') end;`;
        await run(`${read}${check}local f=assert(io.open(p..'${file}_desired.xml','wb'));assert(f:write(${ma2SelectorXmlLiteral(desiredSequence)}));assert(f:close());gma.cmd('Import ${file}_desired.xml At Sequence ${position.number} /o /nc'..${ma2ExchangePath});return 'written'`);
        if (currentSequence) await this.backups.record(bridge, { console: endpoint, object: `Sequence ${position.number}`, files: [file] });
        const actual = await bridge.request('SEQUENCE', position.number);
        if (JSON.stringify(ma2MtcSelectorCommands(actual)) !== JSON.stringify(commands)) throw new Error('控台选曲指令读回不一致，同步没有完成');
      }
      // Native /o imports replace the entire Sequence. Verify the assignment after the
      // import too, so an executor moved or detached during the write is recovered.
      stage('正在核对负责选曲的执行器和时间线');
      const destination = await planMa2SongExecutor(bridge, context, position.number, 1000, '1000.190', this.show, 'bound', new Set(ranges.songTrackExecutors));
      changed ||= !destination.assigned;
      const executor = await assignMa2SongExecutor(connection, bridge, context, position.number, destination, this.show);
      // CREATE refuses an occupied Timecode; an existing selector must carry its own marker.
      const present = source.entries.some(entry => entry.target === position.number);
      let current: string;
      if (present) {
        if (await run(`return tostring(gma.show.property.get(gma.show.getobj.handle('Timecode ${position.number}'),'Info'))`) !== MA2_MTC_SELECTOR_MARK) throw new Error('控台选曲时间线的位置被其他内容占用，没有覆盖');
        current = await bridge.request('READ', position.number);
      } else {
        changed = true;
        current = await bridge.request('CREATE', position.number, '', createMa2TimecodeXml(position.number, selectorName, source.version));
        await run(`gma.cmd('Assign Timecode ${position.number} /Info="${MA2_MTC_SELECTOR_MARK}"');return 'marked'`);
        current = await bridge.request('READ', position.number);
      }
      const selector = ma2MtcPlaybackSettings(ma2SongTimecodeXml(current, position.number, { name: selectorName, startMs: 0, executor: executor,
        executorName: `${selectorName} ${executor}`, sequence: position.number,
        cues: points.map((point, index) => ({ atMs: point.at * 1000 / 30, cueIndex: index + 1, number: String(index + 1), name: null })) }), true);
      if (!sameMa2XmlObjects(current, selector)) {
        changed = true;
        const receipt = await bridge.exchange('APPLY', position.number, current, selector);
        await this.backups.record(bridge, { console: endpoint, object: `Timecode ${position.number}`, files: [`tblink_backup_${receipt.requestId}`] });
      }
      // Install and verify the selector first. Only then let it own the songs' start/stop.
      const checkedSequences = new Set<number>();
      const checking = candidates.filter(entry => {
        const previous = previousRanges?.get(entry.target);
        return !previous || targets.includes(entry.target) || !samePlaybackRange(entry, previous);
      });
      total = checking.length; stage(`正在复核 ${total} 条歌曲时间线的播放设置和序列引用`);
      // The first inventory planned the selector. After installing it, take a second,
      // fresh export of each candidate. A clean Timecode needs only its range and Cue
      // references on the wire. A write still starts from the complete, current XML.
      const currentRanges = async (query: string) => {
        const verified = ma2TimecodeRangesSchema.parse(JSON.parse(await bridge.request('TCRANGES', 1, query)));
        if (verified.show !== source.show || verified.generation !== source.generation) throw new Error('控台 Show 或连接已切换，没有确认选曲');
        if (verified.afterRollSeconds !== ranges.afterRollSeconds) throw new Ma2SelectionRangesChanged(source, changed);
        return verified;
      };
      const inspected = checking.length ? (await currentRanges(`playback:${checking.map(entry => entry.target).join(',')}`)).entries : [];
      const checkedRanges = new Map(inspected.map(entry => [entry.target, entry]));
      for (const candidate of checking) {
        detail = `检查时间线 ${candidate.target}`; report();
        gate();
        const checked = checkedRanges.get(candidate.target);
        if (!checked || !samePlaybackRange(candidate, checked)) throw new Ma2SelectionRangesChanged(source, changed);
        // A preceding queued write may have replaced this song's native track or assignment.
        let sequences = queued && targets.includes(candidate.target) ? undefined : checked.readySequences;
        let write: { current: string; desired: string } | null = null;
        if (!sequences) {
          const xml = await bridge.request('READ', candidate.target);
          if (!samePlaybackRange(candidate, timecodeRange(candidate.target, xml))) throw new Ma2SelectionRangesChanged(source, changed);
          const desired = ma2MtcPlaybackSettings(xml, false);
          if (!sameMa2XmlObjects(xml, desired)) write = { current: xml, desired };
          sequences = referencedMa2Sequences(xml);
        }
        for (const sequence of sequences) {
          if (checkedSequences.has(sequence)) continue;
          checkedSequences.add(sequence);
          gate();
          // syncSong has just compared this complete readback with its intended Cue contents.
          // Reuse that one transaction's evidence for Go-only Cues instead of exporting and reading
          // megabytes of fixture values again after every timeline move. Never retained across syncs.
          if (goSequences.has(sequence) && verifiedTimecode?.show === source.show && verifiedTimecode.generation === source.generation) continue;
          if (await prepareTriggers(sequence, source)) changed = true;
        }
        if (!write) { completed += 1; report(); continue; }
        changed = true;
        await writeSongSettings(candidate.target, write.current, write.desired);
        completed += 1; report();
      }
      // A read-only sequence check can span a desk edit just as a write can. Confirm
      // the same boundaries after the last console operation, before caching success.
      const latest = await currentRanges('editing');
      if (latest.selectorTrackConflict) throw new Error(ma2SelectorTrackProblem(latest.selectorTrackConflict));
      if (latest.selectorCommandTarget === position.number && await restoreSelectorPlayback(source, position.number)) changed = true;
      // Existing running shows must not survive the transition from all-autostart; the native selector owns the next MTC.
      if (changed) await run(`gma.cmd('Off Timecode ${[position.number, ...numbers].join(' + ')}');return 'prepared'`);
      const latestSongs = latest.entries.filter(entry => !entry.internal && entry.slot === MA2_SONG_TIMECODE_SLOT);
      const latestNumbers = new Set(latestSongs.map(entry => entry.target));
      if (numbers.length !== latestNumbers.size || numbers.some(number => !latestNumbers.has(number))
        || JSON.stringify(selectionPoints(latestSongs, ranges.afterRollSeconds)) !== JSON.stringify(points)) throw new Ma2SelectionRangesChanged(source, changed);
      this.knownRanges = { show: source.show, generation: source.generation, entries: ranges.entries.filter(entry => !entry.internal && entry.target !== position.number) };
      this.prepared = endpoint;
      report('控台选曲检查完成');
      return changed;
    } catch (error) { this.invalidate(); throw error; }
  }
}
