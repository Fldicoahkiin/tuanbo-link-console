import { randomBytes } from 'node:crypto';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { z } from 'zod';
import { holdForShow, isShowWait, ma2MtcRange, ma2MtcSelectionCommand, ma2MtcSelections, MA2_SONG_TIMECODE_SLOT, type ShowGateReader } from '@tb/core/link';
import { ma2ObjectDirectorySchema, ma2TimecodeRangesSchema, type Ma2NetworkTarget, type Ma2TimecodeRanges, type Ma2ReadProgressUpdate } from '@tb/schema';
import type { Ma2Telnet } from './ma2-telnet';
import { ma2SequenceGoResultSchema, type Ma2OnpcBridge } from './ma2-onpc-bridge';
import type { Ma2ConsoleBackups } from './ma2-console-backups';
import { ma2LuaString, runMa2GuardedLua } from './ma2-lua-command';
import { createMa2TimecodeXml } from './ma2-create';
import { ma2SongTimecodeXml } from './ma2-song-timecode';
import { assignMa2SongExecutor, planMa2SongExecutor } from './ma2-song-executor';
import { emptyMa2SequenceXml, inspectMa2SequenceXml, inspectMa2TimecodeXml, referencedMa2Sequences, sameMa2XmlObjects, ma2MtcPlaybackSettings } from './ma2-timecode-xml';

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

export type Ma2MtcPreparationTask = { report?: ((progress: Ma2ReadProgressUpdate) => void) | undefined; signal?: AbortSignal | undefined; onConsoleCheck?: () => void };
type Bridge = Pick<Ma2OnpcBridge, 'request' | 'exchange'>;
type Connection = Pick<Ma2Telnet, 'command'>;
export type Ma2ConfirmedTimecode = { number: number; xml: string; show: string; generation: string; goSequences?: readonly number[] };
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
const selectionPoints = (entries: Ma2TimecodeRanges['entries']) => ma2MtcSelections(entries.filter(entry => !entry.internal && entry.slot === MA2_SONG_TIMECODE_SLOT && entry.last !== '').map(ma2MtcRange));
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
    const work = this.queue.then(() => this.install(connection, bridge, network, force, targets, verifiedSequence, verifiedTimecode, task, queued))
      .finally(() => { this.pending--; });
    // Each caller receives its own failure. Releasing the queue is not a retry of that operation.
    this.queue = work.then(() => undefined, () => undefined);
    return work;
  }
  private async install(connection: Connection, sourceBridge: Bridge, network: Ma2NetworkTarget, force: boolean, targets: readonly number[], verifiedSequence?: { number: number; xml: string }, expectedTimecode?: Ma2ConfirmedTimecode, task?: Ma2MtcPreparationTask, queued = false): Promise<boolean> {
    const endpoint = `${network.host}:${network.port}`;
    if (!force && !targets.length && this.prepared === endpoint) return false;
    let completed = 0, total = 0, detail = '正在读取控台时间线目录，检查歌曲怎样按时间码启动';
    const report = (message = detail) => task?.report?.({ phase: 'selection', completed, total, detail: message.slice(0, 128) });
    const stage = (message: string) => { detail = message; report(); };
    const gate = () => { task?.signal?.throwIfAborted(); holdForShow(this.show, 'ma2.sync.write'); };
    const bridge: Bridge = {
      request: async (...args) => (await bridge.exchange(...args)).response,
      exchange: async (operation, target, expected = '', desired = '', signal, progress, behind) => {
        gate();
        const operationName = operation === 'SEQGO' ? `检查序列 ${target} 的触发方式` : operation === 'READ' ? `读取时间线 ${target}` : detail;
        let steps = 0;
        report(operationName);
        try { return await sourceBridge.exchange(operation, target, expected, desired, task?.signal ?? signal, download => {
          steps += 1;
          report(download ? `${operationName} · 已收到 ${download.completed} / ${download.total} 字节` : `${operationName} · 控台已完成 ${steps} 步`);
          progress?.(download);
        }, behind); }
        catch (error) { if (isShowWait(error) || task?.signal?.aborted) throw error; throw new Error(`${operationName}未完成：${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      }
    };
    report();
    let changed = false;
    const known = !force && this.prepared === endpoint ? this.knownRanges : null;
    task?.signal?.throwIfAborted();
    try {
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
            && JSON.stringify(selectionPoints(entries)) === JSON.stringify(selectionPoints(known.entries)))) {
            this.knownRanges = { ...known, entries }; this.prepared = endpoint; return false;
          }
        }
      }
      gate();
      this.invalidate();
      task?.onConsoleCheck?.();
      const source = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST', 1)));
      if (expectedTimecode && (expectedTimecode.show !== source.show || expectedTimecode.generation !== source.generation)) throw new Error('控台 Show 或连接已切换，没有确认选曲');
      stage(`正在核对 ${source.entries.length} 条时间线的起止位置`);
      const refreshing = new Set(targets);
      let ranges: Ma2TimecodeRanges;
      const freshXml = new Map<number, string>();
      const incremental = known && known.show === source.show && known.generation === source.generation;
      if (incremental) {
        const entries: Ma2TimecodeRanges['entries'] = [];
        for (const object of source.entries.filter(entry => !entry.internal)) {
          const previous = known.entries.find(entry => entry.target === object.target);
          if (previous && !refreshing.has(object.target)) { entries.push(previous); continue; }
          gate();
          const xml = verifiedTimecode?.number === object.target && verifiedTimecode.show === source.show && verifiedTimecode.generation === source.generation
            ? verifiedTimecode.xml : await bridge.request('READ', object.target);
          freshXml.set(object.target, xml); refreshing.add(object.target);
          entries.push(timecodeRange(object.target, xml));
        }
        ranges = { show: source.show, entries };
      } else ranges = ma2TimecodeRangesSchema.parse(JSON.parse(await bridge.request('TCRANGES', 1)));
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
      const points = selectionPoints(candidates), numbers = candidates.map(entry => entry.target);
      const commands = points.map(point => numbers.length ? ma2MtcSelectionCommand(numbers, point.timecode) : `Off Timecode ${owned}`);
      const position = positionSchema.parse(JSON.parse(await run(`local o=gma.show.getobj;local n=${owned};local exists=n>0 and o.handle('Sequence '..n)~=nil;if exists then assert(o.label(o.handle('Sequence '..n))=='${selectorName}','Selector sequence changed') elseif n==0 then for i=9900,99999 do if not o.handle('Sequence '..i) and not o.handle('Timecode '..i) then n=i;break end end;assert(n>0,'No free selector object') end;return '{"number":'..n..',"exists":'..tostring(exists)..'}'`)));
      const context = { network, expectedSource: { show: source.show, generation: source.generation, version: source.version } };
      const desiredSequence = ma2MtcSelectorSequence(position.number, source.version, commands);
      let currentSequence: string | null = null;
      if (position.exists) currentSequence = await bridge.request('SEQUENCE', position.number);
      const sequenceChanged = !currentSequence || JSON.stringify(ma2MtcSelectorCommands(currentSequence)) !== JSON.stringify(commands);
      if (sequenceChanged) {
        stage(`正在更新并核对控台选曲指令，共 ${commands.length} 条`);
        changed = true;
        const file = `tblink_library_${randomBytes(16).toString('hex')}`;
        const check = currentSequence === null ? `assert(not gma.show.getobj.handle('Sequence ${position.number}'),'Selector position occupied');`
          : `local h=gma.show.getobj.handle('Sequence ${position.number}');assert(h and gma.show.property.get(h,'Info')=='${MA2_MTC_SELECTOR_MARK}','Selector ownership changed');gma.cmd('Export Sequence ${position.number} ${file}_check /o');assert(canonical(read('${file}_check'))==canonical(${ma2SelectorXmlLiteral(currentSequence)}),'Selector changed during write');gma.cmd('Export Sequence ${position.number} ${file} /o');assert(read('${file}'));`;
        const read = `local p=gma.show.getvar('PATH')..'/importexport/';local function read(n)local f=assert(io.open(p..n..'.xml','rb'));local s=f:read('*a');f:close();return s end;local function canonical(s)return s:gsub('<Info[^>]*/>',''):gsub('>[%s]+<','><') end;`;
        const oldCues = currentSequence ? inspectMa2SequenceXml(currentSequence).sequences[0]!.cues.map(cue => Number(cue.number)) : [];
        await run(`${read}${check}local f=assert(io.open(p..'${file}_desired.xml','wb'));assert(f:write(${ma2SelectorXmlLiteral(desiredSequence)}));assert(f:close());${oldCues.length ? `gma.cmd('Delete Sequence ${position.number} Cue ${oldCues.join(' + ')} /nc');` : ''}gma.cmd('Import ${file}_desired.xml At Sequence ${position.number} /o /nc');return 'written'`);
        if (currentSequence) await this.backups.record(bridge, { console: endpoint, object: `Sequence ${position.number}`, files: [file] });
        const actual = await bridge.request('SEQUENCE', position.number);
        if (JSON.stringify(ma2MtcSelectorCommands(actual)) !== JSON.stringify(commands)) throw new Error('控台选曲指令读回不一致，同步没有完成');
      }
      // Removing all selector Cues can detach its executor on native MA2. Read the assignment
      // after importing the replacement Sequence; a pre-import plan is no longer evidence.
      stage('正在核对负责选曲的执行器和时间线');
      const destination = await planMa2SongExecutor(bridge, context, position.number, 1000, '1000.190', this.show);
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
      const checking = candidates.filter(entry => !incremental || refreshing.has(entry.target));
      total = checking.length; stage(`正在复核 ${total} 条歌曲时间线的播放设置和序列引用`);
      // The first inventory planned the selector. After installing it, take a second,
      // fresh export of each candidate. A clean Timecode needs only its range and Cue
      // references on the wire. A write still starts from the complete, current XML.
      const checkedRanges = new Map<number, Ma2TimecodeRanges['entries'][number]>();
      if (!incremental && checking.length) {
        const verified = ma2TimecodeRangesSchema.parse(JSON.parse(await bridge.request('TCRANGES', 1, `playback:${checking.map(entry => entry.target).join(',')}`)));
        if (verified.show !== source.show || verified.generation !== source.generation) throw new Error('控台 Show 或连接已切换，没有确认选曲');
        for (const entry of verified.entries) checkedRanges.set(entry.target, entry);
      }
      for (const candidate of checking) {
        detail = `检查时间线 ${candidate.target}`; report();
        gate();
        const checked = checkedRanges.get(candidate.target);
        const moved = () => new Error(`Timecode ${candidate.target} 在准备期间有变化，选曲还没确认，请重新同步`);
        if (!incremental && (!checked || !samePlaybackRange(candidate, checked))) throw moved();
        let sequences = checked?.readySequences;
        let write: { current: string; desired: string } | null = null;
        if (!sequences) {
          const xml = freshXml.get(candidate.target) ?? await bridge.request('READ', candidate.target);
          if (!samePlaybackRange(candidate, timecodeRange(candidate.target, xml))) throw moved();
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
          const readback = await bridge.exchange('SEQGO', sequence, `${Buffer.from(source.show).toString('hex')}\n${Buffer.from(source.generation).toString('hex')}`);
          const result = ma2SequenceGoResultSchema.parse(JSON.parse(readback.response));
          if (result.changed) {
            await this.backups.record(bridge, { console: endpoint, object: `Sequence ${sequence}`, files: [`tblink_library_${readback.requestId}`] });
            changed = true;
          }
        }
        if (!write) { completed += 1; report(); continue; }
        changed = true;
        const receipt = await bridge.exchange('APPLY', candidate.target, write.current, write.desired);
        await this.backups.record(bridge, { console: endpoint, object: `Timecode ${candidate.target}`, files: [`tblink_backup_${receipt.requestId}`] });
        completed += 1; report();
      }
      // Existing running shows must not survive the transition from all-autostart; the native selector owns the next MTC.
      if (changed) await run(`gma.cmd('Off Timecode ${[position.number, ...numbers].join(' + ')}');return 'prepared'`);
      this.knownRanges = { show: source.show, generation: source.generation, entries: ranges.entries.filter(entry => !entry.internal && entry.target !== position.number) };
      this.prepared = endpoint;
      report('控台选曲检查完成');
      return changed;
    } catch (error) { this.invalidate(); throw error; }
  }
}
