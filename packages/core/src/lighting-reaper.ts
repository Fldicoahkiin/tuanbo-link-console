import { createLightingDocument, lightingDocumentSchema, lightingTempoSchema, type LightingClip, type LightingEvent, type LightingTempo } from '@tb/schema';
import { LightingTempoMap } from './lighting-edit';
import { importLightingMidi, type LightingImport } from './lighting-midi-file';
import type { MidiEvent } from 'midi-file';
import { writeLightingMidi } from './lighting-midi-writer';

type RppNode = { tag: string; args: string[]; lines: string[][]; children: RppNode[]; entries: Array<string[] | RppNode> };
export function importLightingReaper(text: string, externalMidi: ReadonlyMap<string, Uint8Array> = new Map(), projectPath = ''): LightingImport {
  if (text.length > 32 * 1024 * 1024) throw new Error('REAPER 工程超过 32 MB');
  const root = parseRpp(text);
  if (root.tag !== 'REAPER_PROJECT') throw new Error('不是 REAPER 工程');
  const resolveMidi = externalMidiResolver(externalMidi, projectPath);
  const document = createLightingDocument();
  const tempo = line(root, 'TEMPO');
  const bpm = numeric(tempo?.[1] ?? '120');
  const hasSignature = tempo?.[2] !== undefined || tempo?.[3] !== undefined;
  document.tempos = [lightingTempoSchema.parse({ beat: 0, bpm,
    numerator: hasSignature ? numeric(tempo?.[2]) : 4,
    denominator: hasSignature ? numeric(tempo?.[3]) : 4
  })];
  const warnings = new Set<string>();
  const tempoEnvelope = root.children.find((node) => node.tag === 'TEMPOENVEX');
  if (tempoEnvelope) document.tempos = importTempoEnvelope(tempoEnvelope, document.tempos[0]!);
  const map = new LightingTempoMap(document.tempos);
  const regions = new Map<string, string[][]>();
  for (const marker of root.lines.filter((row) => row[0] === 'MARKER')) {
    const flags = numeric(marker[4] ?? '0');
    if (!Number.isSafeInteger(flags)) throw new Error('REAPER 标记状态无效');
    if (flags & 1) {
      const regionId = marker[1];
      if (!regionId || !/^\d+$/.test(regionId)) throw new Error('REAPER 区域编号无效');
      const pair = regions.get(regionId) ?? []; pair.push(marker); regions.set(regionId, pair);
    } else document.markers.push({ id: crypto.randomUUID(), name: marker[3] || `标记 ${marker[1]}`, startMs: numeric(marker[2]) * 1000, endMs: null });
  }
  for (const [regionId, pair] of regions) {
    if (pair.length !== 2) throw new Error(`REAPER 区域 ${regionId} 缺少端点或编号重复`);
    pair.sort((a, b) => numeric(a[2]) - numeric(b[2]));
    const start = pair[0]!; const end = pair[1]!;
    const startMs = numeric(start[2]) * 1000; const endMs = numeric(end[2]) * 1000;
    if (endMs <= startMs) throw new Error(`REAPER 区域 ${regionId} 长度无效`);
    document.markers.push({ id: crypto.randomUUID(), name: start[3] || `区域 ${regionId}`, startMs, endMs });
  }
  document.markers.sort((a, b) => a.startMs - b.startMs);
  for (const [index, sourceTrack] of root.children.filter((node) => node.tag === 'TRACK').entries()) {
    const name = line(sourceTrack, 'NAME')?.[1] || `REAPER ${index + 1}`;
    const muteSolo = line(sourceTrack, 'MUTESOLO');
    const mute = numeric(muteSolo?.[1] ?? '0'); const solo = numeric(muteSolo?.[2] ?? '0');
    if (![0, 1].includes(mute) || ![0, 1, 2].includes(solo)) throw new Error(`${name}：轨道静音或独奏状态无效`);
    if (muteSolo?.[3] && muteSolo[3] !== '0') warnings.add(`${name}：独奏豁免未转换，请检查轨道独奏设置`);
    if (sourceTrack.children.some((node) => node.tag === 'FXCHAIN')) warnings.add(`${name}：FX 插件处理未转换`);
    for (const { item, inactive } of sourceTrack.children.filter((node) => node.tag === 'ITEM').flatMap(itemTakes)) {
      if (item.children.some((node) => node.tag === 'TAKEFX')) warnings.add(`${name}：Take FX 插件处理未转换`);
      const source = item.children.find((node) => node.tag === 'SOURCE');
      if (!source || source.args[0] !== 'MIDI') { warnings.add(`${name}：非 MIDI 素材未转换`); continue; }
      const file = line(source, 'FILE')?.[1];
      let imported: LightingImport;
      if (file) {
        const data = resolveMidi(file);
        if (!data) throw new Error(`缺少 REAPER 外部 MIDI 文件：${file}。请与工程一起选择。`);
        imported = importLightingMidi(data);
      } else imported = importEmbedded(source);
      imported.warnings.forEach((warning) => warnings.add(`${name}：${warning}`));
      const positionMs = numeric(line(item, 'POSITION')?.[1] ?? '0') * 1000;
      const lengthMs = numeric(line(item, 'LENGTH')?.[1]) * 1000;
      const offsetMs = Number(line(item, 'SOFFS')?.[1] ?? '0') * 1000;
      if (!Number.isFinite(offsetMs)) throw new Error('REAPER 素材起点偏移无效');
      const playRate = numeric(line(item, 'PLAYRATE')?.[1] ?? '1');
      if (playRate <= 0) throw new Error('REAPER 片段播放速度必须为正数');
      const loops = line(item, 'LOOP')?.[1] === '1';
      const ignoreTempo = line(source, 'IGNTEMPO');
      const ignore = numeric(ignoreTempo?.[1] ?? '0');
      if (ignore !== 0 && ignore !== 1) throw new Error('REAPER MIDI 节拍跟随设置无效');
      const sourceMap = ignore === 1 ? new LightingTempoMap([lightingTempoSchema.parse({ ...document.tempos[0], beat: 0, transition: 'hold', bpm: numeric(ignoreTempo?.[2]) })]) : map;
      const variableTempo = ignore === 0 && document.tempos.length > 1;
      // Native REAPER 6.05 MIDI_GetProjTimeFromPPQPos fixtures establish the
      // source origin in project seconds, then scale source quarter notes.
      const sourceOriginMs = positionMs - offsetMs / playRate;
      // Native loop fixtures confirm a constant initial tempo before zero,
      // rather than extending the first ramp backwards into negative BPM.
      const initialMsPerBeat = 60000 / sourceMap.rateAt(0).bpm;
      const sourceOriginBeat = variableTempo ? (sourceOriginMs < 0 ? sourceOriginMs / initialMsPerBeat : sourceMap.msToBeat(sourceOriginMs)) : 0;
      for (const track of imported.document.tracks) {
        const sourceClip = track.clips[0]; if (!sourceClip) continue;
        const sourceEnd = sourceClip.events.reduce((end, event) => Math.max(end, event.at + (event.kind === 'note' ? event.duration : 0)), 0);
        const cycleBeats = Math.max(sourceEnd, sourceClip.duration - 0.001);
        const cycleMs = sourceMap.beatToMs(cycleBeats);
        if (loops && cycleMs <= 0) throw new Error('REAPER 循环素材没有有效长度');
        const events: LightingEvent[] = [];
        const count = loops ? Math.max(0, variableTempo ? Math.ceil((sourceMap.msToBeat(positionMs + lengthMs) - sourceOriginBeat) * playRate / cycleBeats) : Math.ceil((offsetMs + lengthMs * playRate) / cycleMs)) : 1;
        if (count > 10000) throw new Error('REAPER 片段循环次数过多');
        const eventTime = (beat: number, repeat: number): number => {
          if (!variableTempo) return (sourceMap.beatToMs(beat) + repeat * cycleMs - offsetMs) / playRate;
          const projectBeat = sourceOriginBeat + (beat + repeat * cycleBeats) / playRate;
          return (projectBeat < 0 ? projectBeat * initialMsPerBeat : sourceMap.beatToMs(projectBeat)) - positionMs;
        };
        for (let repeat = 0; repeat < count; repeat += 1) for (const event of sourceClip.events) {
          const at = eventTime(event.at, repeat);
          if (at >= lengthMs) continue;
          if (event.kind === 'note') {
            const end = eventTime(event.at + event.duration, repeat);
            if (end <= 0) continue;
            events.push({ ...event, id: crypto.randomUUID(), at: Math.max(0, at), duration: Math.min(lengthMs, end) - Math.max(0, at) });
          } else if (at >= 0) events.push({ ...event, id: crypto.randomUUID(), at });
        }
        const clip: LightingClip = { id: crypto.randomUUID(), name: (line(item, 'NAME')?.[1] || name) + (sourceClip.muted ? ' · 静音事件' : ''), start: positionMs, duration: lengthMs, timeLock: 'time', muted: inactive || sourceClip.muted || line(item, 'MUTE')?.[1] === '1', events };
        const existing = document.tracks.find((entry) => entry.group === `${index}` && entry.channel === track.channel);
        if (existing) existing.clips.push(clip);
        else document.tracks.push({ ...track, id: crypto.randomUUID(), name, muted: mute === 1, solo: solo !== 0, locked: line(sourceTrack, 'LOCK')?.[1] === '1', group: `${index}`, clips: [clip] });
      }
    }
  }
  return { document: lightingDocumentSchema.parse(document), warnings: [...warnings] };
}

function itemTakes(item: RppNode): Array<{ item: RppNode; inactive: boolean }> {
  const all = numeric(line(item, 'ALLTAKES')?.[1] ?? '0');
  if (all !== 0 && all !== 1) throw new Error('REAPER 全部 Take 播放状态无效');
  // REAPER 6.05 stores TAKE/TAKE SEL as separators, not nested blocks.
  const takes: RppNode[] = [{ tag: 'ITEM', args: [], lines: [], children: [], entries: [] }];
  let selected = 0;
  let explicitSelection = false;
  for (const entry of item.entries) {
    if (Array.isArray(entry) && entry[0] === 'TAKE') {
      if (entry.length > 2 || (entry[1] !== undefined && entry[1] !== 'SEL')) throw new Error('REAPER Take 标志还不支持');
      if (entry[1] === 'SEL') {
        if (explicitSelection) throw new Error('REAPER 存在多个启用 Take');
        selected = takes.length;
        explicitSelection = true;
      }
      takes.push({ tag: 'ITEM', args: [], lines: [], children: [], entries: [] });
      continue;
    }
    if (!Array.isArray(entry) && entry.tag === 'TAKE') throw new Error('REAPER Take 块格式还不支持');
    const current = takes[takes.length - 1]!;
    current.entries.push(entry);
    if (Array.isArray(entry)) current.lines.push(entry);
    else current.children.push(entry);
  }
  const shared = takes[0]!.lines.filter((row) => ['POSITION', 'LENGTH', 'LOOP', 'MUTE'].includes(row[0]!));
  return takes.map((take, index) => {
    if (take.children.filter((node) => node.tag === 'SOURCE').length > 1) throw new Error('REAPER Take 含多个素材源，无法确定播放内容');
    return { item: index === 0 ? take : { ...take, lines: [...shared, ...take.lines] }, inactive: all === 0 && index !== selected };
  });
}

function importTempoEnvelope(envelope: RppNode, initial: LightingTempo): LightingTempo[] {
  const active = numeric(line(envelope, 'ACT')?.[1] ?? '1');
  if (active === 0) return [initial];
  if (active !== 1) throw new Error('REAPER 变速包络启用状态无效');
  const points = envelope.lines.filter((row) => row[0] === 'PT');
  const tempos: LightingTempo[] = [initial];
  let previousMs = 0; let previousPointMs = -1;
  for (const point of points) {
    const ms = numeric(point[1]) * 1000;
    if (ms <= previousPointMs) throw new Error('REAPER 变速点必须按时间递增');
    previousPointMs = ms;
    const previous = tempos.at(-1)!;
    const bpm = numeric(point[2]);
    const rawShape = point[3] === '-1' ? line(envelope, 'DEFSHAPE')?.[1] : point[3];
    const shape = numeric(rawShape);
    if (shape !== 0 && shape !== 1) throw new Error('REAPER 变速包络包含还不支持的曲线形状');
    const signature = numeric(point[4] ?? '0');
    if (!Number.isSafeInteger(signature) || signature > 0xffffffff) throw new Error('REAPER 变速拍号编码无效');
    const beat = previous.beat + (ms - previousMs) * (previous.transition === 'linear' ? previous.bpm + bpm : previous.bpm * 2) / 120000;
    const tempo = lightingTempoSchema.parse({ beat, bpm, numerator: signature ? signature % 65536 : previous.numerator, denominator: signature ? Math.floor(signature / 65536) : previous.denominator, transition: shape === 0 ? 'linear' : 'hold' });
    if (ms === 0) tempos[0] = tempo; else tempos.push(tempo);
    previousMs = ms;
  }
  return tempos;
}

function externalMidiResolver(files: ReadonlyMap<string, Uint8Array>, projectPath: string): (reference: string) => Uint8Array | undefined {
  const normalize = (path: string): string => {
    const parts: string[] = [];
    for (const part of path.replace(/\\/g, '/').toLowerCase().split('/')) {
      if (part === '.') continue;
      if (part === '..' && parts.length && parts.at(-1) !== '..' && parts.at(-1) !== '' && !parts.at(-1)?.endsWith(':')) parts.pop();
      else parts.push(part);
    }
    return parts.join('/');
  };
  const paths = new Map<string, Uint8Array>();
  const names = new Map<string, string[]>();
  for (const [path, bytes] of files) {
    const key = normalize(path);
    if (paths.has(key)) throw new Error(`重复选择了 REAPER 外部 MIDI 文件：${path}`);
    paths.set(key, bytes);
    const name = key.split('/').at(-1) ?? key;
    names.set(name, [...(names.get(name) ?? []), key]);
  }
  const project = normalize(projectPath); const directory = project.slice(0, project.lastIndexOf('/') + 1);
  return (reference) => {
    const key = normalize(reference);
    const resolved = directory && !/^(?:[a-z]:\/|\/)/i.test(key) ? normalize(directory + key) : key;
    const exact = paths.get(resolved) ?? paths.get(key);
    if (exact) return exact;
    const candidates = names.get(key.split('/').at(-1) ?? key) ?? [];
    if (candidates.length > 1) throw new Error(`REAPER 外部 MIDI 存在同名文件，无法确定引用：${reference}。请按工程中的目录结构选择文件。`);
    return candidates[0] ? paths.get(candidates[0]) : undefined;
  };
}

function importEmbedded(source: RppNode): LightingImport {
  const ppq = numeric(line(source, 'HASDATA')?.[2] ?? '960');
  if (!Number.isInteger(ppq) || ppq < 1 || ppq > 32767) throw new Error('REAPER MIDI 节拍精度无效');
  const events: Array<{ tick: number; muted: boolean; event: MidiEvent }> = [];
  let tick = 0;
  for (const entry of source.entries) {
    if (!Array.isArray(entry)) {
      if (!/^[Xx]$/.test(entry.tag) || entry.args.length !== 2 || entry.args[1] !== '0' || entry.children.length) throw new Error('REAPER 内嵌 MIDI 扩展块类型或标志还不支持');
      const delta = numeric(entry.args[0]);
      if (!Number.isSafeInteger(delta)) throw new Error('REAPER MIDI 增量时间必须为整数');
      tick += delta;
      const encoded = entry.lines.flat().join('');
      if (!encoded || encoded.length > 87384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('REAPER SysEx 编码无效或消息过长');
      const bytes = Array.from(atob(encoded), (character) => character.charCodeAt(0));
      if (bytes.length < 3 || bytes.length > 65536 || bytes[0] !== 0xf0 || bytes.at(-1) !== 0xf7 || bytes.slice(1, -1).some((byte) => byte > 127)) throw new Error('REAPER SysEx 必须是完整且有效的 F0…F7 消息');
      events.push({ tick, muted: false, event: { deltaTime: 0, type: 'sysEx', data: bytes.slice(1) } });
      continue;
    }
    const row = entry;
    if (!/^[Ee]m?$/.test(row[0] ?? '')) continue;
    const delta = numeric(row[1]);
    if (!Number.isInteger(delta)) throw new Error('REAPER MIDI 增量时间必须为整数');
    tick += delta;
    if (row.slice(2).some((value) => !/^[0-9a-f]{1,2}$/i.test(value))) throw new Error('REAPER MIDI 字节无效');
    const bytes = row.slice(2).map((value) => Number.parseInt(value, 16));
    if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error('REAPER MIDI 字节无效');
    const status = bytes[0] ?? 0; const channel = status & 15; const a = bytes[1] ?? 0; const b = bytes[2] ?? 0;
    const kind = status & 0xf0;
    if (kind >= 0x80 && kind <= 0xe0) {
      const shortMessage = kind === 0xc0 || kind === 0xd0;
      if ((shortMessage ? bytes.length !== 2 && !(bytes.length === 3 && b === 0) : bytes.length !== 3) || bytes.slice(1).some((byte) => byte > 127)) throw new Error('REAPER MIDI 数据长度或数据字节无效');
    }
    const base = { deltaTime: 0, channel }; let event: MidiEvent;
    switch (status & 0xf0) {
      case 0x80: event = { ...base, type: 'noteOff', noteNumber: a, velocity: b }; break;
      case 0x90: event = { ...base, type: 'noteOn', noteNumber: a, velocity: b }; break;
      case 0xb0: event = { ...base, type: 'controller', controllerType: a, value: b }; break;
      case 0xc0: event = { ...base, type: 'programChange', programNumber: a }; break;
      case 0xa0: event = { ...base, type: 'noteAftertouch', noteNumber: a, amount: b }; break;
      case 0xd0: event = { ...base, type: 'channelAftertouch', amount: a }; break;
      case 0xe0: event = { ...base, type: 'pitchBend', value: (a | b << 7) - 8192 }; break;
      default: throw new Error(`REAPER 内嵌 MIDI 消息 ${status.toString(16)} 还不支持，请导出标准 MIDI`);
    }
    events.push({ tick, muted: row[0]!.endsWith('m'), event });
  }
  const parts = [false, true].map((muted) => {
    let previous = 0;
    const messages: MidiEvent[] = events.filter((entry) => entry.muted === muted).map((entry) => {
      const message = { ...entry.event, deltaTime: entry.tick - previous }; previous = entry.tick; return message;
    });
    messages.push({ type: 'endOfTrack', deltaTime: tick - previous });
    const imported = importLightingMidi(writeLightingMidi([messages], ppq));
    for (const track of imported.document.tracks) for (const clip of track.clips) clip.muted = muted;
    return imported;
  });
  const result = parts[0]!;
  result.document.tracks.push(...parts[1]!.document.tracks);
  result.warnings.push(...parts[1]!.warnings);
  return result;
}
function line(node: RppNode, key: string): string[] | undefined { return node.lines.find((row) => row[0] === key); }
function numeric(text: string | undefined): number { const value = text === undefined ? NaN : Number(text); if (!Number.isFinite(value) || value < 0) throw new Error('REAPER 数值缺失或无效'); return value; }
function parseRpp(text: string): RppNode {
  const stack: RppNode[] = []; let root: RppNode | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const value = raw.trim(); if (!value) continue;
    if (value === '>') { if (!stack.length) throw new Error('REAPER 块结束不匹配'); stack.pop(); continue; }
    const opening = value.startsWith('<');
    const tokens = (opening ? value.slice(1) : value).match(/"(?:\\.|[^"\\])*"|`[^`]*`|'[^']*'|[^\s]+/g)?.map((token) => /^["'`]/.test(token) ? token.slice(1, -1).replace(/\\"/g, '"') : token) ?? [];
    if (opening) {
      const node: RppNode = { tag: tokens[0] ?? '', args: tokens.slice(1), lines: [], children: [], entries: [] };
      if (stack.length) { stack.at(-1)!.children.push(node); stack.at(-1)!.entries.push(node); } else { if (root) throw new Error('REAPER 根块重复'); root = node; }
      stack.push(node); if (stack.length > 64) throw new Error('REAPER 嵌套过深');
    } else { if (!stack.length) throw new Error('REAPER 根块之外存在数据'); stack.at(-1)!.lines.push(tokens); stack.at(-1)!.entries.push(tokens); }
  }
  if (!root || stack.length) throw new Error('REAPER 工程不完整');
  return root;
}
