import { randomBytes } from 'node:crypto';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { z } from 'zod';
import { holdForShow, ma2MtcSelectionCommand, ma2MtcSelections, MA2_SONG_TIMECODE_SLOT, type Ma2MtcSong, type ShowGateReader } from '@tb/core/link';
import { ma2ObjectDirectorySchema, ma2TimecodeRangesSchema, type Ma2NetworkTarget, type Ma2TimecodeRanges } from '@tb/schema';
import type { Ma2Telnet } from './ma2-telnet';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import type { Ma2ConsoleBackups } from './ma2-console-backups';
import { ma2LuaString, runMa2GuardedLua } from './ma2-lua-command';
import { createMa2TimecodeXml } from './ma2-create';
import { ma2SongTimecodeXml } from './ma2-song-timecode';
import { assignMa2SongExecutor, planMa2SongExecutor } from './ma2-song-executor';
import { emptyMa2SequenceXml, inspectMa2SequenceXml, inspectMa2TimecodeXml, sameMa2XmlObjects, ma2MtcPlaybackSettings, ma2SequenceCueFingerprints } from './ma2-timecode-xml';

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

type Bridge = Pick<Ma2OnpcBridge, 'request' | 'exchange'>;
type Connection = Pick<Ma2Telnet, 'command'>;
export type Ma2ConfirmedTimecode = { number: number; xml: string; show: string; generation: string };
const timecodeRange = (target: number, xml: string): Ma2TimecodeRanges['entries'][number] => {
  const tc = inspectMa2TimecodeXml(xml).timecodes[0]!;
  const events = tc.tracks.flatMap(track => track.subtracks.flatMap(subtrack => subtrack.events));
  const last = events.length ? events.reduce((max, event) => Math.max(max, Number(event.attributes.time ?? 0)), 0) : null;
  return { target, name: tc.attributes.name ?? '', offset: tc.attributes.offset ?? '0', length: tc.attributes.lenght ?? '',
    slot: tc.attributes.slot ?? '', frame: tc.attributes.frame_format ?? '', last: last === null ? '' : String(last) };
};
const selectionPoints = (entries: Ma2TimecodeRanges['entries']) => ma2MtcSelections(entries.filter(entry => entry.last !== '').map((entry): Ma2MtcSong => {
  const start = Number(entry.offset), length = Math.max(Number(entry.length || 0), Number(entry.last) + 1);
  return { timecode: entry.target, start, end: start + length };
}));
const positionSchema = z.object({ number: z.number().int().min(1).max(99999), exists: z.boolean() }).strict();

/**
 * The sole compiler/installer of the console's MTC song selector. Runs only while editing/syncing.
 * The selector itself is native MA2 Timecode + empty command Cues: playback, seeking and P1 need no network or Lua loop.
 */
export class Ma2MtcSelectionService {
  private queue: Promise<void> = Promise.resolve();
  private prepared: string | null = null;
  private knownRanges: { show: string; generation: string; entries: Ma2TimecodeRanges['entries'] } | null = null;
  constructor(private readonly show: ShowGateReader, private readonly backups: Pick<Ma2ConsoleBackups, 'record'>) {}
  invalidate(): void { this.prepared = null; this.knownRanges = null; }
  prepare(connection: Connection, bridge: Bridge, network: Ma2NetworkTarget, force = false, targets: readonly number[] = [], verifiedSequence?: { number: number; xml: string }, verifiedTimecode?: Ma2ConfirmedTimecode): Promise<boolean> {
    const work = this.queue.then(() => this.install(connection, bridge, network, force, targets, verifiedSequence, verifiedTimecode));
    // Each caller receives its own failure. Releasing the queue is not a retry of that operation.
    this.queue = work.then(() => undefined, () => undefined);
    return work;
  }
  private async install(connection: Connection, bridge: Bridge, network: Ma2NetworkTarget, force: boolean, targets: readonly number[], verifiedSequence?: { number: number; xml: string }, verifiedTimecode?: Ma2ConfirmedTimecode): Promise<boolean> {
    const endpoint = `${network.host}:${network.port}`;
    if (!force && !targets.length && this.prepared === endpoint) return false;
    const gate = () => holdForShow(this.show, 'ma2.sync.write');
    let changed = false;
    const known = !force && this.prepared === endpoint ? this.knownRanges : null;
    gate(); this.invalidate();
    try {
      // A point moved inside the same song interval does not change the native selector. Use the
      // Timecode this sync actually read back, so moving the end, muting all points or changing the
      // MTC origin still rebuilds selection even when the Sequence itself was not edited.
      if (known && verifiedTimecode && known.show === verifiedTimecode.show && known.generation === verifiedTimecode.generation
        && targets.length === 1 && targets[0] === verifiedTimecode.number && known.entries.some(entry => entry.target === verifiedTimecode.number)
        && verifiedSequence && !ma2MtcSequenceSettings(verifiedSequence.xml).cues.length
        && sameMa2XmlObjects(verifiedTimecode.xml, ma2MtcPlaybackSettings(verifiedTimecode.xml, false))) {
        const fresh = timecodeRange(verifiedTimecode.number, verifiedTimecode.xml);
        const entries = known.entries.map(entry => entry.target === fresh.target ? fresh : entry);
        if (fresh.slot === MA2_SONG_TIMECODE_SLOT && JSON.stringify(selectionPoints(entries)) === JSON.stringify(selectionPoints(known.entries))) {
          this.knownRanges = { ...known, entries }; this.prepared = endpoint; return false;
        }
      }
      const source = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST', 1)));
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
      if (source.show !== ranges.show) throw new Error('控台 Show 已切换，没有准备选曲');
      const guard = `assert(gma.show.getvar('SHOWFILE')==${ma2LuaString(source.show)} and TBLINK_BRIDGE_GENERATION==${ma2LuaString(source.generation)},'Show or session changed');`;
      const run = (body: string) => runMa2GuardedLua(connection, guard + body, gate);
      // Marker belongs to the native Show, so another computer reuses the same selector.
      const owned = Number(await run(`local o=gma.show.getobj;local found=0;for _,kind in ipairs({'Sequence','Timecode'}) do local pool=o.handle(kind);for i=0,o.amount(pool)-1 do local h=o.child(pool,i);if h and gma.show.property.get(h,'Info')=='${MA2_MTC_SELECTOR_MARK}' then local n=tonumber(o.number(h));assert(found==0 or found==n,'Duplicate MTC selector');found=n end end end;return found`));
      const candidates = ranges.entries.filter(entry => entry.target !== owned && entry.slot === MA2_SONG_TIMECODE_SLOT);
      if (!candidates.some(entry => entry.last !== '') && !owned) { this.prepared = endpoint; return false; }
      const points = selectionPoints(candidates), numbers = candidates.map(entry => entry.target);
      const commands = points.map(point => numbers.length ? ma2MtcSelectionCommand(numbers, point.timecode) : `Off Timecode ${owned}`);
      const position = positionSchema.parse(JSON.parse(await run(`local o=gma.show.getobj;local n=${owned};local exists=n>0 and o.handle('Sequence '..n)~=nil;if exists then assert(o.label(o.handle('Sequence '..n))=='${selectorName}','Selector sequence changed') elseif n==0 then for i=9900,99999 do if not o.handle('Sequence '..i) and not o.handle('Timecode '..i) then n=i;break end end;assert(n>0,'No free selector object') end;return '{"number":'..n..',"exists":'..tostring(exists)..'}'`)));
      const context = { network, expectedSource: { show: source.show, generation: source.generation, version: source.version } };
      const desiredSequence = ma2MtcSelectorSequence(position.number, source.version, commands);
      let currentSequence: string | null = null;
      if (position.exists) currentSequence = await bridge.request('SEQUENCE', position.number);
      const sequenceChanged = !currentSequence || JSON.stringify(ma2MtcSelectorCommands(currentSequence)) !== JSON.stringify(commands);
      if (sequenceChanged) {
        changed = true;
        const file = `tblink_library_${randomBytes(16).toString('hex')}`;
        const check = currentSequence === null ? `assert(not gma.show.getobj.handle('Sequence ${position.number}'),'Selector position occupied');`
          : `local h=gma.show.getobj.handle('Sequence ${position.number}');assert(h and gma.show.property.get(h,'Info')=='${MA2_MTC_SELECTOR_MARK}','Selector ownership changed');gma.cmd('Export Sequence ${position.number} ${file}_check /o');assert(canonical(read('${file}_check'))==canonical(${ma2LuaString(currentSequence)}),'Selector changed during write');gma.cmd('Export Sequence ${position.number} ${file} /o');assert(read('${file}'));`;
        const read = `local p=gma.show.getvar('PATH')..'/importexport/';local function read(n)local f=assert(io.open(p..n..'.xml','rb'));local s=f:read('*a');f:close();return s end;local function canonical(s)return s:gsub('<Info[^>]*/>',''):gsub('>[%s]+<','><') end;`;
        const oldCues = currentSequence ? inspectMa2SequenceXml(currentSequence).sequences[0]!.cues.map(cue => Number(cue.number)) : [];
        await run(`${read}${check}local f=assert(io.open(p..'${file}_desired.xml','wb'));assert(f:write(${ma2LuaString(desiredSequence)}));assert(f:close());${oldCues.length ? `gma.cmd('Delete Sequence ${position.number} Cue ${oldCues.join(' + ')} /nc');` : ''}gma.cmd('Import ${file}_desired.xml At Sequence ${position.number} /o /nc');return 'written'`);
        if (currentSequence) await this.backups.record(bridge, { console: endpoint, object: `Sequence ${position.number}`, files: [file] });
        const actual = await bridge.request('SEQUENCE', position.number);
        if (JSON.stringify(ma2MtcSelectorCommands(actual)) !== JSON.stringify(commands)) throw new Error('控台选曲指令读回不一致，同步没有完成');
      }
      // Removing all selector Cues can detach its executor on native MA2. Read the assignment
      // after importing the replacement Sequence; a pre-import plan is no longer evidence.
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
      for (const candidate of candidates.filter(entry => !incremental || refreshing.has(entry.target))) {
        gate();
        const xml = freshXml.get(candidate.target) ?? await bridge.request('READ', candidate.target), desired = ma2MtcPlaybackSettings(xml, false);
        const timecode = inspectMa2TimecodeXml(xml).timecodes[0]!;
        const eventTimes = timecode.tracks.flatMap(track => track.subtracks.flatMap(subtrack => subtrack.events.map(event => Number(event.attributes.time ?? 0))));
        const last = eventTimes.length ? String(eventTimes.reduce((max, time) => Math.max(max, time), 0)) : '';
        if (Number(timecode.attributes.offset ?? 0) !== Number(candidate.offset) || Number(timecode.attributes.lenght ?? 0) !== Number(candidate.length || 0)
          || last !== candidate.last || timecode.attributes.slot !== candidate.slot) throw new Error(`Timecode ${candidate.target} 在准备期间有变化，选曲还没确认，请重新同步`);
        const sequences = timecode.tracks.flatMap(track => track.subtracks.flatMap(subtrack => subtrack.events.flatMap(event =>
          event.cueAddress?.[0] === '1' && event.cueAddress[1] ? [Number(event.cueAddress[1])] : [])));
        for (const sequence of sequences) {
          if (checkedSequences.has(sequence)) continue;
          checkedSequences.add(sequence);
          gate();
          // syncSong has just compared this complete readback with its intended Cue contents.
          // Reuse that one transaction's evidence for Go-only Cues instead of exporting and reading
          // megabytes of fixture values again after every timeline move. Never retained across syncs.
          if (verifiedSequence?.number === sequence && !ma2MtcSequenceSettings(verifiedSequence.xml).cues.length) continue;
          const readback = await bridge.exchange('SEQUENCE', sequence, 'keep');
          const file = `tblink_library_${readback.requestId}`;
          const settings = ma2MtcSequenceSettings(readback.response);
          if (!settings.cues.length) { await bridge.request('DISCARD', 1, file); continue; }
          await this.backups.record(bridge, { console: endpoint, object: `Sequence ${sequence}`, files: [file] });
          // Native Assign changes only the trigger; fixture data, fades and command content remain byte-for-byte verified.
          await run(`local p=gma.show.getvar('PATH')..'/importexport/';local function read(n)local f=assert(io.open(p..n..'.xml','rb'));local s=f:read('*a');f:close();return s end;local function canonical(s)return s:gsub('<Info[^>]*/>',''):gsub('>[%s]+<','><') end;gma.cmd('Export Sequence ${sequence} ${file}_check /o');assert(canonical(read('${file}_check'))==canonical(read('${file}')),'Song changed during trigger preparation');os.remove(p..'${file}_check.xml');gma.cmd('Assign Sequence ${sequence} Cue ${settings.cues.map(Number).join(' + ')} /Trig=Go');return 'prepared'`);
          const actual = await bridge.request('SEQUENCE', sequence);
          if (JSON.stringify([...ma2SequenceCueFingerprints(settings.xml)]) !== JSON.stringify([...ma2SequenceCueFingerprints(actual)])) throw new Error(`Sequence ${sequence} 的时间线触发读回不一致，请检查控台`);
          changed = true;
        }
        if (sameMa2XmlObjects(xml, desired)) continue;
        changed = true;
        const receipt = await bridge.exchange('APPLY', candidate.target, xml, desired);
        await this.backups.record(bridge, { console: endpoint, object: `Timecode ${candidate.target}`, files: [`tblink_backup_${receipt.requestId}`] });
      }
      // Existing running shows must not survive the transition from all-autostart; the native selector owns the next MTC.
      if (changed) await run(`gma.cmd('Off Timecode ${[position.number, ...numbers].join(' + ')}');return 'prepared'`);
      this.knownRanges = { show: source.show, generation: source.generation, entries: candidates };
      this.prepared = endpoint;
      return changed;
    } catch (error) { this.invalidate(); throw error; }
  }
}
