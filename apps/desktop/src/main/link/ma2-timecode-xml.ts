import { createHash } from 'node:crypto';
import { DOMParser, XMLSerializer, type Element as XmlElement } from '@xmldom/xmldom';
import { z } from 'zod';
import { ma2CueAttributesSchema, ma2LayoutSnapshotSchema, type Ma2CueAttributes, type Ma2LayoutSnapshot } from '@tb/schema';
import { inspectMa2CueContent } from './ma2-cue-content';
import { ma2ExecutorPageSchema, type Ma2ExecutorPage } from '@tb/schema';

const MA_NAMESPACE = 'http://schemas.malighting.de/grandma2/xml/MA';
export type Ma2ExecutorReport = { version: string; sequence: number; assignmentName: string; executorName?: string };

/** Page exports retain sparse Exec slots. offset_from_first describes a wide executor, not its address. */
export function inspectMa2ExecutorPageXml(xml: string, target: number): Ma2ExecutorPage {
  const { root } = parse(xml);
  const version = ['major_vers', 'minor_vers', 'stream_vers'].map(name => required(root, name)).join('.');
  if (!['3.3.4', '3.7.0'].includes(version)) throw new Error('此 MA2 执行器页面 XML 版本尚未验证');
  const page = singleChild(root, 'Page');
  if (!page || indexOf(page) + 1 !== target) throw new Error('执行器页面回读编号不一致');
  const slots = children(page, 'Exec');
  if (slots.length > 240) throw new Error('执行器页面格子数超出已验证范围');
  const items: Ma2ExecutorPage['items'] = [];
  for (const [index, executor] of slots.entries()) {
    if (executor.getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'nil') === 'true') continue;
    const offset = Number(required(executor, 'offset_from_first'));
    if (!Number.isInteger(offset) || offset < 0 || offset > 14) throw new Error('执行器宽度信息无效');
    if (offset) {
      const first = items.find(item => item.slot === index + 1 - offset);
      if (!first || first.width !== offset) throw new Error('多格执行器起点缺失');
      first.width += 1; continue;
    }
    const assignment = singleChild(executor, 'Assignment');
    const reference = address(assignment);
    const sequence = reference.length === 3 && reference[0] === '25' && reference[1] === '1' && /^[1-9]\d*$/.test(reference[2] ?? '') ? Number(reference[2]) : undefined;
    const buttons = singleChild(executor, 'AssignmentExec');
    const button = buttons ? children(buttons, 'Button')[0]?.textContent : null;
    const label = executor.getAttribute('tblink_label');
    // A native label is authoritative. Never append an internal sequence or executor number.
    const name = label ?? assignment?.getAttribute('name')?.replace(sequence ? new RegExp(` ${sequence}$`) : /$^/, '') ?? '';
    items.push({ slot: index + 1, width: 1, name, kind: sequence ? 'sequence' : 'other', ...(sequence ? { sequence } : {}), reference, button: button ? Number(button) : null });
  }
  const show = root.getAttribute('tblink_show'); const generation = root.getAttribute('tblink_generation'); const nativeVersion = root.getAttribute('tblink_version');
  const metadata = singleChild(root, 'tblink_sequences');
  const sequences = metadata ? children(metadata, 'tblink_sequence').map(value => ({ sequence: Number(required(value, 'number')), name: value.getAttribute('name') || null,
    cues: children(value, 'tblink_cue').map(cue => {
      const number = required(cue, 'number');
      if (!/^\d{1,4}(?:\.\d{1,3})?$/.test(number) || Number(number) <= 0) throw new Error('页面 Cue 编号无效，未采用读取结果');
      return { index: Number(required(cue, 'index')), number: Number(number).toFixed(3), name: cue.getAttribute('name') || null };
    }) })) : [];
  return ma2ExecutorPageSchema.parse({ page: target, name: page.getAttribute('name') ?? '', readAt: new Date().toISOString(), items,
    sequences,
    ...(show && generation && nativeVersion ? { source: { show, generation, version: nativeVersion } } : {}) });
}

/** Native MA2 Layout exports use Group/LayoutData; object coordinates remain in MA units. */
export function inspectMa2LayoutXml(xml: string, target: number): Ma2LayoutSnapshot {
  const { root } = parse(xml);
  const version = ['major_vers', 'minor_vers', 'stream_vers'].map(name => required(root, name)).join('.');
  if (!['3.3.4', '3.7.0'].includes(version)) throw new Error('此 MA2 Layout XML 版本尚未验证');
  const group = singleChild(root, 'Group');
  if (!group || indexOf(group) + 1 !== target) throw new Error('Layout 回读对象不一致');
  const layout = singleChild(group, 'LayoutData');
  if (!layout) throw new Error('Layout 缺少画布数据');
  const objects = singleChild(layout, 'CObjects');
  const items = (objects ? children(objects, 'LayoutCObject') : []).map((item, index) => {
    const object = singleChild(item, 'CObject'); const reference = address(object);
    const sequence = reference.length >= 3 && reference[0] === '25' && reference[1] === '1' && /^[1-9]\d*$/.test(reference[2] ?? '') ? Number(reference[2]) : undefined;
    const coordinate = (name: string): number => { const value = Number(required(item, name)); if (!Number.isFinite(value) || Math.abs(value) > 100000) throw new Error('Layout 坐标无效'); return value; };
    // Cue addresses are not silently guessed from internal indices.
    return { id: String(index), name: object?.getAttribute('name') ?? '', reference, kind: sequence && reference.length === 3 ? 'sequence' as const : 'other' as const, ...(sequence && reference.length === 3 ? { sequence } : {}), x: coordinate('center_x'), y: coordinate('center_y'), width: coordinate('size_w'), height: coordinate('size_h') };
  });
  return ma2LayoutSnapshotSchema.parse({ layout: target, name: group.getAttribute('name') ?? '', items, omittedFixtures: layout.getElementsByTagNameNS(MA_NAMESPACE, 'LayoutSubFix').length, readAt: new Date().toISOString() });
}

export function moveMa2LayoutObjects(xml: string, layout: number, positions: readonly { id: string; x: number; y: number }[], name?: string): string {
  inspectMa2LayoutXml(xml, layout);
  const { root, document } = parse(xml); const group = singleChild(root, 'Group')!;
  if (name !== undefined) group.setAttribute('name', name);
  const objects = singleChild(singleChild(group, 'LayoutData')!, 'CObjects');
  const items = objects ? children(objects, 'LayoutCObject') : [];
  for (const position of positions) {
    const item = items[Number(position.id)]; if (!item) throw new Error('Layout 对象已不存在');
    item.setAttribute('center_x', String(position.x)); item.setAttribute('center_y', String(position.y));
  }
  return new XMLSerializer().serializeToString(document);
}

/** A fresh, empty destination prevents current programmer values leaking into a combination. */
export function emptyMa2SequenceXml(target: number, version: string): string {
  const base = version.split('.').slice(0,3).join('.');
  if (!['3.3.4','3.7.0'].includes(base) || !Number.isInteger(target) || target < 1 || target > 99999) throw new Error('新建序列版本或编号无效');
  const [major,minor,stream] = base.split('.');
  return `<MA xmlns="${MA_NAMESPACE}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" major_vers="${major}" minor_vers="${minor}" stream_vers="${stream}"><Sequ index="${target-1}"><Cue xsi:nil="true"/><Cue index="1"><Number number="1" sub_number="0"/><CuePart index="0"/></Cue></Sequ></MA>`;
}

export function emptyMa2LayoutXml(target: number, version: string): string {
  const sequence=emptyMa2SequenceXml(target,version);
  return sequence.replace(/<Sequ[\s\S]*<\/Sequ>/,`<Group index="${target-1}"><LayoutData index="0"/></Group>`);
}

/** Edit only the selected song sequence, retaining every untouched native Cue. */
export function editMa2SongSequence(xml: string, name: string, changes: readonly { cue: string; name: string; sources?: readonly { xml: string; cue: string }[] }[], removed: readonly string[]): string {
  inspectMa2SequenceXml(xml);
  const { document, root } = parse(xml); const sequence = singleChild(root, 'Sequ');
  if (!sequence) throw new Error('歌曲序列缺失');
  sequence.setAttribute('name', name);
  const report = inspectMa2SequenceXml(xml).sequences[0]!;
  let index = Math.max(0, ...report.cues.map(cue => cue.index));
  for (const number of removed) {
    const ref = report.cues.find(cue => Number(cue.number) === Number(number));
    const element = children(sequence, 'Cue').find(cue => cue.getAttribute('index') === String(ref?.index));
    if (element) sequence.removeChild(element);
  }
  for (const change of changes) {
    const ref = report.cues.find(cue => Number(cue.number) === Number(change.cue));
    let cue = children(sequence, 'Cue').find(cue => cue.getAttribute('index') === String(ref?.index));
    if (!cue) {
      cue = document.createElementNS(MA_NAMESPACE, 'Cue'); cue.setAttribute('index', String(++index));
      const number = document.createElementNS(MA_NAMESPACE, 'Number'); const [whole, fraction = ''] = change.cue.split('.');
      number.setAttribute('number', whole!); number.setAttribute('sub_number', String(Number(fraction.padEnd(3, '0')))); cue.appendChild(number); sequence.appendChild(cue);
    }
    if (change.sources !== undefined) {
      for (const child of [...children(cue, 'CueDatas'), ...children(cue, 'CuePart')]) cue.removeChild(child);
      const rows = new Map<string, XmlElement>();
      for (const source of change.sources) {
        const sourceReport = inspectMa2SequenceXml(source.xml).sequences[0]!;
        const sourceRef = sourceReport.cues.find(value => Number(value.number) === Number(source.cue));
        if (!sourceRef) throw new Error(`来源 Cue ${source.cue} 已不存在`);
        inspectMa2CueData(source.xml, sourceRef.index);
        const sourceCue = children(singleChild(parse(source.xml).root, 'Sequ')!, 'Cue').find(value => value.getAttribute('index') === String(sourceRef.index))!;
        if (change.sources.length === 1) {
          for (const part of children(sourceCue, 'CuePart')) cue.appendChild(document.importNode(part, true));
        } else if (children(sourceCue, 'CuePart').some(part => part.getAttribute('index') !== '0' || part.childNodes.length > 0)) throw new Error('组合含多 Part 或 Cue 命令，不能静态合成到歌曲序列');
        const data = singleChild(sourceCue, 'CueDatas');
        for (const row of data ? children(data, 'CueData') : []) {
          const key = JSON.stringify(canonicalElement(singleChild(row, 'Channel')!));
          const existing = rows.get(key);
          if (!existing) { rows.set(key, document.importNode(row, true)); continue; }
          for (const layer of children(row, 'Channel').length ? Array.from({ length: row.childNodes.length }, (_, i) => row.childNodes.item(i)).filter((node): node is XmlElement => node?.nodeType === 1 && (node as XmlElement).localName !== 'Channel') : []) {
            for (const previous of children(existing, layer.localName!)) existing.removeChild(previous);
            existing.appendChild(document.importNode(layer, true));
          }
        }
      }
      if (rows.size) { const data = document.createElementNS(MA_NAMESPACE, 'CueDatas'); for (const row of rows.values()) data.appendChild(row); cue.appendChild(data); }
    }
    if (!children(cue, 'CuePart').length) { const part = document.createElementNS(MA_NAMESPACE, 'CuePart'); part.setAttribute('index', '0'); cue.appendChild(part); }
    cue.setAttribute('name', change.name);
    children(cue, 'CuePart').find(part => part.getAttribute('index') === '0')?.setAttribute('name', change.name);
  }
  return new XMLSerializer().serializeToString(document);
}

/** Explicit values/effect layers for a conservative native merge readback comparison. */
export function inspectMa2CueData(xml: string, cueIndex: number): Map<string,Record<string,string>> {
  inspectMa2SequenceXml(xml);
  const {root}=parse(xml);const sequence=singleChild(root,'Sequ');
  const cue=sequence&&children(sequence,'Cue').find(value=>value.getAttribute('index')===String(cueIndex));
  if(!cue)throw new Error('Cue 数据索引不存在');
  const result=new Map<string,Record<string,string>>();
  const data=singleChild(cue,'CueDatas');
  for(const row of data?children(data,'CueData'):[]){
    const channel=singleChild(row,'Channel');if(!channel)throw new Error('CueData 缺少灯具属性引用');
    const key=JSON.stringify(canonicalElement(channel));
    if(result.has(key))throw new Error('同一灯具属性包含多条数据，暂不能静态合成');
    if(['value_multipart_index','effect_multipart_index'].some(name=>row.hasAttribute(name)&&row.getAttribute(name)!=='0'))throw new Error('暂不能静态合成多 Part Cue，请保留原组合引用');
    const layers:Record<string,string>={};
    for(let child=row.firstChild;child;child=child.nextSibling)if(child.nodeType===1&&(child as XmlElement).localName!=='Channel'){
      const element=child as XmlElement;const name=element.localName??element.nodeName;
      if(name in layers)throw new Error('属性层包含重复值，暂不能静态合成');
      layers[name]=JSON.stringify(canonicalElement(element));
    }
    result.set(key,layers);
  }
  return result;
}

/** A single-executor export has relative offset zero, not its absolute page/address. */
export function inspectMa2ExecutorXml(xml: string): Ma2ExecutorReport {
  const { root } = parse(xml);
  const version = ['major_vers', 'minor_vers', 'stream_vers'].map((name) => required(root, name)).join('.');
  if (version !== '3.3.4' && version !== '3.7.0') throw new Error('该 MA2 执行器 XML 版本尚未验证');
  const executor = singleChild(root, 'Exec');
  if (!executor || required(executor, 'offset_from_first') !== '0') throw new Error('必须读取单个明确执行器');
  const assignment = singleChild(executor, 'Assignment');
  if (!assignment) throw new Error('执行器尚未分配序列');
  const reference = address(assignment).map((value) => value.trim());
  if (reference.length !== 3 || reference[0] !== '25' || reference[1] !== '1') throw new Error('执行器分配的对象不是已支持的 Sequence');
  const sequence = reference[2]!;
  if (!/^[1-9]\d*$/.test(sequence) || Number(sequence) > 99999) throw new Error('执行器的序列编号无效');
  const executorName = executor.getAttribute('tblink_executor_name');
  if (executorName !== null && (!executorName || executorName.length > 512 || /[\u0000-\u001f]/.test(executorName))) throw new Error('执行器名称无效');
  return { version, sequence: Number(sequence), assignmentName: required(assignment, 'name'), ...(executorName !== null ? { executorName } : {}) };
}

export type Ma2SequenceReport = {
  version: string;
  sequences: Array<{ number: number; name: string | null; cues: Array<{ index: number; number: string; name: string | null }> }>;
};

/** Only explicitly stored channels; does not resolve tracking, output or programmer state. */
export function inspectMa2CueAttributes(xml: string, readAt: string, fullExport = false): Ma2CueAttributes[] {
  inspectMa2SequenceXml(xml);
  const { root } = parse(xml);
  return indexedChildren(root, 'Sequ').flatMap(sequence => {
    const cues = children(sequence, 'Cue').filter(cue => cue.hasAttribute('index') && cue.getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'nil') !== 'true');
    const contents = cues.map(cue => inspectMa2CueContent(cue, 'none', fullExport));
    // Tracking can wrap from the last step back to the first. Without executor
    // settings, no unwritten step in a data-bearing sequence is proven empty.
    const tracking = contents.some(content => content.state === 'partial') ? 'unverified' : contents.some(content => content.rows.length) ? 'possible' : 'none';
    return cues.map((cue, cueIndex) => {
      const content = { ...contents[cueIndex]!, tracking };
      const attributes = new Set<string>(); const fixtureIds = new Set<number>();
      let unknownChannels = 0; let hasEffects = false;
      const channels = cue.getElementsByTagNameNS(MA_NAMESPACE, 'Channel');
      for (let index = 0; index < channels.length; index++) {
        const channel = channels.item(index)!;
        const attribute = channel.getAttribute('attribute_name');
        if (attribute?.trim()) attributes.add(attribute); else unknownChannels++;
        const fixture = channel.getAttribute('fixture_id');
        if (fixture && /^[1-9]\d*$/.test(fixture) && Number.isSafeInteger(Number(fixture))) fixtureIds.add(Number(fixture));
        else if (!/^[1-9]\d*$/.test(channel.getAttribute('channel_id') ?? '')) unknownChannels++;
        const data = channel.parentNode;
        if (data?.nodeType === 1 && (data as XmlElement).getElementsByTagNameNS(MA_NAMESPACE, 'Effect').length > 0) hasEffects = true;
      }
      return ma2CueAttributesSchema.parse({ sequence: indexOf(sequence) + 1, cueIndex: indexOf(cue), attributes: [...attributes].sort(), fixtureIds: [...fixtureIds].sort((a,b) => a-b), unknownChannels, hasEffects, content, readAt });
    });
  });
}

/** Explicit fixture references only. Tracking and programmer state are not inferred. */
export function inspectMa2CueFixtures(xml: string): { sequence: number; cueIndex: number; fixtureIds: number[] }[] {
  const { root } = parse(xml);
  return indexedChildren(root, 'Sequ').flatMap(sequence => children(sequence, 'Cue').filter(cue => cue.hasAttribute('index')).map(cue => {
    const fixtureIds = new Set<number>();
    const channels = cue.getElementsByTagNameNS(MA_NAMESPACE, 'Channel');
    for (let index = 0; index < channels.length; index++) {
      const value = channels.item(index)?.getAttribute('fixture_id');
      if (!value) continue;
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Cue 灯具编号无效');
      fixtureIds.add(Number(value));
    }
    return { sequence: indexOf(sequence) + 1, cueIndex: indexOf(cue), fixtureIds: [...fixtureIds].sort((a, b) => a - b) };
  }));
}

export function inspectMa2SequenceXml(xml: string, allowEmpty = false): Ma2SequenceReport {
  const { root } = parse(xml);
  const version = ['major_vers', 'minor_vers', 'stream_vers'].map((name) => required(root, name)).join('.');
  if (!['3.3.4', '3.7.0'].includes(version)) throw new Error('该 MA2 序列 XML 版本尚未验证');
  const sequences = indexedChildren(root, 'Sequ').map((sequence) => {
    const indices = new Set<number>(); const numbers = new Set<string>();
    const cues = children(sequence, 'Cue').filter((cue) => cue.getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'nil') !== 'true').map((cue) => {
      const index = indexOf(cue);
      const value = singleChild(cue, 'Number');
      if (!value) throw new Error('MA2 Cue 缺少实际编号');
      const whole = required(value, 'number'); const fraction = value.getAttribute('sub_number') ?? '0';
      if (!/^\d+$/.test(whole) || !/^\d+$/.test(fraction) || Number(whole) > 9999 || Number(fraction) > 999 || Number(whole) + Number(fraction) === 0) throw new Error('MA2 Cue 编号无效');
      const number = `${Number(whole)}.${String(Number(fraction)).padStart(3, '0')}`;
      if (indices.has(index) || numbers.has(number)) throw new Error('MA2 Cue 索引或编号重复');
      indices.add(index); numbers.add(number);
      const firstPart = children(cue, 'CuePart').find((part) => part.getAttribute('index') === '0');
      return { index, number, name: cue.getAttribute('name') ?? firstPart?.getAttribute('name') ?? null };
    });
    return { number: indexOf(sequence) + 1, name: sequence.getAttribute('name'), cues };
  });
  if (!sequences.length && !allowEmpty) throw new Error('文件中没有 MA2 Sequence 对象');
  return { version, sequences };
}

/** Compare all surviving Cue metadata and Parts while allowing MA2 to reindex internal steps. */
export function ma2SequenceCueFingerprints(xml: string): Map<string, string> {
  const report = inspectMa2SequenceXml(xml);
  const { root } = parse(xml);
  const result = new Map<string, string>();
  for (const sequence of indexedChildren(root, 'Sequ')) for (const cue of children(sequence, 'Cue')) {
    if (cue.getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'nil') === 'true') continue;
    const number = report.sequences.find(value => value.number === indexOf(sequence) + 1)?.cues.find(value => value.index === indexOf(cue))?.number;
    if (!number) throw new Error('Cue 编号不能核对');
    const clone = cue.cloneNode(true) as XmlElement;
    clone.removeAttribute('index');
    result.set(number, JSON.stringify(canonicalElement(clone)));
  }
  return result;
}

export function resolveMa2CueReference(address: readonly string[], reports: readonly Ma2SequenceReport[]): { sequence: number; cueIndex: number; cueNumber: string; cueName: string | null } {
  if (address.length !== 3 || address[0] !== '1' || !address.slice(1).every((value) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)))) throw new Error('尚不支持的 MA2 Cue 引用结构');
  const sequenceNumber = Number(address[1]); const cueIndex = Number(address[2]);
  const matches = reports.flatMap((report) => report.sequences).filter((sequence) => sequence.number === sequenceNumber);
  if (matches.length !== 1) throw new Error(`序列 ${sequenceNumber} 的导出数据缺失或不唯一`);
  const cue = matches[0]?.cues.find((entry) => entry.index === cueIndex);
  if (!cue) throw new Error(`序列 ${sequenceNumber} 内部 Cue 索引 ${cueIndex} 无法解析，请重新读取控台`);
  return { sequence: sequenceNumber, cueIndex, cueNumber: cue.number, cueName: cue.name };
}

/** Resolve the user-facing Cue number using freshly exported sequence data. */
export function resolveMa2CueNumber(sequenceNumber: number, cueNumber: string, reports: readonly Ma2SequenceReport[]): { sequence: number; cueIndex: number; cueNumber: string; cueName: string | null } {
  if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 1 || sequenceNumber > 99999 || !/^\d{1,4}(?:\.\d{1,3})?$/.test(cueNumber)) throw new Error('MA2 序列或 Cue 编号无效');
  const [whole = '0', fraction = ''] = cueNumber.split('.');
  const normalized = `${Number(whole)}.${fraction.padEnd(3, '0')}`;
  if (normalized === '0.000') throw new Error('MA2 Cue 编号不能为零');
  const sequences = reports.flatMap((report) => report.sequences).filter((sequence) => sequence.number === sequenceNumber);
  if (sequences.length !== 1) throw new Error(`序列 ${sequenceNumber} 的导出数据缺失或不唯一`);
  const matches = sequences[0]?.cues.filter((cue) => cue.number === normalized) ?? [];
  if (matches.length !== 1 || !matches[0]) throw new Error(`序列 ${sequenceNumber} 中不存在唯一的 Cue ${cueNumber}，请重新读取控台`);
  const cue = matches[0];
  return { sequence: sequenceNumber, cueIndex: cue.index, cueNumber: cue.number, cueName: cue.name };
}

export type Ma2XmlEvent = {
  path: string;
  attributes: Record<string, string>;
  cueName: string | null;
  cueAddress: string[];
};
export type Ma2XmlReport = {
  sha256: string;
  version: string;
  timecodes: Array<{
    index: number;
    attributes: Record<string, string>;
    tracks: Array<{
      index: number;
      attributes: Record<string, string>;
      executorName: string | null;
      executorAddress: string[];
      subtracks: Array<{ index: number; attributes: Record<string, string>; events: Ma2XmlEvent[] }>;
    }>;
  }>;
  warnings: string[];
};

export function inspectMa2TimecodeXml(xml: string): Ma2XmlReport {
  const { root } = parse(xml);
  const warnings = new Set<string>();
  const version = ['major_vers', 'minor_vers', 'stream_vers'].map((name) => required(root, name)).join('.');
  if (!['3.7.0', '3.3.4'].includes(version)) warnings.add(`尚未验证的 MA2 XML 版本：${version}`);
  const timecodes = indexedChildren(root, 'Timecode').map((timecode) => ({
    index: indexOf(timecode), attributes: attributes(timecode),
    tracks: indexedChildren(timecode, 'Track').map((track) => {
      const object = singleChild(track, 'Object');
      return {
        index: indexOf(track), attributes: attributes(track),
        executorName: object?.getAttribute('name') ?? null, executorAddress: address(object),
        subtracks: indexedChildren(track, 'SubTrack').map((subtrack) => ({
          index: indexOf(subtrack), attributes: attributes(subtrack),
          events: indexedChildren(subtrack, 'Event').map((event) => {
            const cue = singleChild(event, 'Cue');
            if (event.hasAttribute('fader_level')) warnings.add(version === '3.3.4' && subtrack.getAttribute('fader_command') === 'Master'
              ? 'Master 推杆点可同步；点间插值由 MA2 执行，尚未完成播放测量'
              : '存在尚未验证的推杆类型或版本，保留原始数据');
            else if (!['Goto', 'Go', 'Off'].includes(event.getAttribute('command') ?? '')) warnings.add('存在尚未完成实机验证的执行器动作，保留原始数据');
            return { path: eventPath(timecode, track, subtrack, event), attributes: attributes(event), cueName: cue?.getAttribute('name') ?? null, cueAddress: address(cue) };
          })
        }))
      };
    })
  }));
  if (!timecodes.length) throw new Error('文件中没有 MA2 Timecode 对象');
  return { sha256: hash(xml), version, timecodes, warnings: [...warnings] };
}

export function validateMa2TimecodeWrite(xml: string): void {
  const { root } = parse(xml);
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.nodeType !== 1) continue;
    const element = child as XmlElement;
    if (element.namespaceURI !== MA_NAMESPACE || !['Info', 'Timecode'].includes(element.localName ?? '')) throw new Error('同步 XML 含 Timecode 以外的对象，禁止写入');
  }
}

export function referencedMa2Sequences(xml: string): number[] {
  const references = new Set<number>();
  for (const tc of inspectMa2TimecodeXml(xml).timecodes) for (const track of tc.tracks) for (const subtrack of track.subtracks) for (const event of subtrack.events) {
    if (!event.cueAddress.length) continue;
    if (event.cueAddress.length !== 3 || event.cueAddress[0] !== '1' || !event.cueAddress.slice(1).every((value) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)))) throw new Error('MA2 快照 Cue 引用结构无效');
    const sequence = Number(event.cueAddress[1]);
    if (sequence < 1 || sequence > 99999) throw new Error('MA2 快照序列编号无效');
    references.add(sequence);
  }
  return [...references].sort((a, b) => a - b);
}

export function validateMa2TimecodeSnapshot(xml: string, additionalSequences: readonly number[] = []): void {
  const { root } = parse(xml);
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.nodeType !== 1) continue;
    const element = child as XmlElement;
    if (element.namespaceURI !== MA_NAMESPACE || !['Info', 'Timecode', 'Sequ'].includes(element.localName ?? '')) throw new Error('MA2 快照含绑定范围外的对象');
  }
  if (additionalSequences.some((number) => !Number.isInteger(number) || number < 1 || number > 99999)) throw new Error('额外序列编号无效');
  const references = new Set([...referencedMa2Sequences(xml), ...additionalSequences]);
  const sequences = children(root, 'Sequ').length ? inspectMa2SequenceXml(xml).sequences : [];
  if (sequences.length !== references.size || sequences.some((sequence) => !references.has(sequence.number))) throw new Error('MA2 快照的关联序列缺失或超出绑定范围');
}

export function extractMa2TimecodeXml(xml: string, target: number): string {
  const { document, root } = parse(xml);
  const timecodes = indexedChildren(root, 'Timecode');
  const selected = timecodes.find((timecode) => indexOf(timecode) === target - 1);
  if (!selected) throw new Error('快照中没有绑定的 Timecode');
  for (let child = root.firstChild; child;) {
    const next = child.nextSibling;
    if (child !== selected) root.removeChild(child);
    child = next;
  }
  return new XMLSerializer().serializeToString(document);
}

export function sameMa2XmlObjects(a: string, b: string): boolean {
  const normalize = (xml: string): string => {
    inspectMa2TimecodeXml(xml);
    const { root } = parse(xml);
    return JSON.stringify(indexedChildren(root, 'Timecode').map(canonicalElement));
  };
  return normalize(a) === normalize(b);
}

type CanonicalElement = { name: string; attributes: Array<[string, string]>; content: Array<string | CanonicalElement> };
function canonicalElement(element: XmlElement): CanonicalElement {
  const attributes: Array<[string, string]> = [];
  // onPC derives this display step from the assigned sequence and preceding actions.
  // Go/Off have no Cue reference; their step is not an editable command target.
  const derivedStep = element.namespaceURI === MA_NAMESPACE && element.localName === 'Event'
    && ['Go', 'Off'].includes(element.getAttribute('command') ?? '') && element.getAttribute('pressed') === 'true';
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (derivedStep && attribute?.name === 'step' && !attribute.namespaceURI) continue;
    if (attribute && attribute.namespaceURI !== 'http://www.w3.org/2000/xmlns/') attributes.push([`${attribute.namespaceURI ?? ''}:${attribute.localName ?? attribute.name}`, attribute.value]);
  }
  attributes.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const content: Array<string | CanonicalElement> = [];
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) content.push(canonicalElement(child as XmlElement));
    else if (child.nodeType === 3 || child.nodeType === 4) {
      const text = child.nodeValue ?? '';
      if (text.trim()) {
        const previous = content.at(-1);
        if (typeof previous === 'string') content[content.length - 1] = previous + text;
        else content.push(text);
      }
    }
  }
  return { name: `${element.namespaceURI ?? ''}:${element.localName ?? element.tagName}`, attributes, content };
}

// Offline probe only. Ticks remain in the source XML unit until console validation.
// Paths identify nodes in this exact file, never persistent synchronization IDs.
export function patchMa2EventTimes(xml: string, expectedSha256: string, changes: ReadonlyArray<{ path: string; rawTime: string }>): string {
  if (hash(xml) !== expectedSha256) throw new Error('MA2 XML 在预览后已改变');
  const report = inspectMa2TimecodeXml(xml);
  if (!['3.7.0', '3.3.4'].includes(report.version)) throw new Error('该 MA2 XML 版本尚未验证，禁止修改');
  const { document, root } = parse(xml);
  const nodes = new Map<string, XmlElement>();
  for (const tc of indexedChildren(root, 'Timecode')) {
    for (const track of indexedChildren(tc, 'Track')) {
      for (const subtrack of indexedChildren(track, 'SubTrack')) {
        for (const event of indexedChildren(subtrack, 'Event')) nodes.set(eventPath(tc, track, subtrack, event), event);
      }
    }
  }
  const changed = new Set<string>();
  for (const change of changes) {
    if (changed.has(change.path)) throw new Error('同一事件存在重复修改');
    changed.add(change.path);
    const node = nodes.get(change.path);
    if (!node) throw new Error(`MA2 事件不存在：${change.path}`);
    if (!/^\d+(?:\.\d+)?$/.test(change.rawTime) || !Number.isFinite(Number(change.rawTime))) throw new Error('MA2 时间值无效');
    node.setAttribute('time', change.rawTime);
  }
  return changes.length ? (xml.startsWith('\uFEFF') ? '\uFEFF' : '') + new XMLSerializer().serializeToString(document) : xml;
}

const cueReferenceSchema = z.object({ sequence: z.number().int().min(1).max(99999), cueIndex: z.number().int().min(1), name: z.string() }).strict();
const rawTimeSchema = z.string().regex(/^\d+(?:\.\d+)?$/).refine((value) => Number.isFinite(Number(value)), 'MA2 时间值无效');
const faderLevelSchema = z.string().regex(/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/).refine((value) => Number(value) === Number(Number(value).toFixed(3)), 'MA2 3.3.4 主推杆精度为 0.1%');
const ma2EventEditSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('update'), path: z.string().min(1), rawTime: rawTimeSchema.optional(), faderLevel: faderLevelSchema.optional(), cue: cueReferenceSchema.optional(), executorAction: z.enum(['go', 'off']).optional() }).strict(),
  z.object({ kind: z.literal('delete'), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('add'), subtrackPath: z.string().min(1), rawTime: rawTimeSchema, faderLevel: faderLevelSchema.optional(), cue: cueReferenceSchema.optional(), executorAction: z.enum(['go', 'off']).optional() }).strict()
]);
export type Ma2EventEdit = z.infer<typeof ma2EventEditSchema>;
export type Ma2EventWrite = { xml: string; originalPaths: Map<string, string>; addedPaths: Map<number, string> };

/** Modify only the bound Timecode. Cue indices must come from a live sequence read. */
export function editMa2TimecodeEvents(xml: string, expectedSha256: string, target: number, input: readonly Ma2EventEdit[]): string {
  return prepareMa2TimecodeEvents(xml, expectedSha256, target, input).xml;
}

/** Track enable state is native Timecode data; preserve the executor object and events. */
export function editMa2TrackStates(xml: string, target: number, input: readonly { path: string; muted: boolean }[]): string {
  const edits = z.array(z.object({ path: z.string().min(1), muted: z.boolean() }).strict()).parse(input);
  validateMa2TimecodeWrite(xml);
  const report = inspectMa2TimecodeXml(xml);
  if (report.timecodes.length !== 1 || report.timecodes[0]?.index !== target - 1) throw new Error('轨道写入目标与 Timecode 不一致');
  if (!['3.3.4', '3.7.0'].includes(report.version)) throw new Error('该 MA2 轨道格式尚未验证');
  if (new Set(edits.map((entry) => entry.path)).size !== edits.length) throw new Error('轨道修改路径重复');
  if (!edits.length) return xml;
  const { document, root } = parse(xml);
  const tracks = new Map<string, XmlElement>(indexedChildren(root, 'Timecode').flatMap((tc) => indexedChildren(tc, 'Track').map((track) => [`Timecode:${indexOf(tc)}/Track:${indexOf(track)}`, track] as const)));
  for (const edit of edits) {
    const track = tracks.get(edit.path);
    if (!track) throw new Error('找不到待修改的 MA2 轨道');
    if (edit.muted) track.removeAttribute('active');
    else track.setAttribute('active', 'true');
  }
  return new XMLSerializer().serializeToString(document);
}

/** Retain event identity across reindexing so readback does not guess from Cue or time. */
export function prepareMa2TimecodeEvents(xml: string, expectedSha256: string, target: number, input: readonly Ma2EventEdit[]): Ma2EventWrite {
  if (hash(xml) !== expectedSha256) throw new Error('MA2 XML 在预览后已改变');
  validateMa2TimecodeWrite(xml);
  const report = inspectMa2TimecodeXml(xml);
  const tc = report.timecodes[0];
  if (report.timecodes.length !== 1 || tc?.index !== target - 1) throw new Error('写入目标 Timecode 与 XML 不一致');
  if (!['3.3.4', '3.7.0'].includes(report.version) || tc.attributes.frame_format !== '30 FPS' || !/^\d+(?:\.\d+)?$/.test(tc.attributes.offset ?? '0')) throw new Error('该 Timecode 格式或时间基准尚未验证');
  const edits = z.array(ma2EventEditSchema).parse(input);
  for (const edit of edits) {
    if (edit.kind === 'delete') continue;
    if ([edit.cue, edit.executorAction, edit.faderLevel].filter((value) => value !== undefined).length > 1) throw new Error('执行器动作不能同时指定 Cue 或推杆值');
    if (edit.kind === 'add' && !edit.cue && !edit.executorAction && edit.faderLevel === undefined) throw new Error('新增事件必须指定 Cue、执行器动作或推杆值');
  }
  if (!edits.length) return { xml, originalPaths: new Map(tc.tracks.flatMap((track) => track.subtracks.flatMap((subtrack) => subtrack.events.map((event) => [event.path, event.path])))), addedPaths: new Map() };
  const { document, root } = parse(xml);
  const nodes = new Map<string, XmlElement>(); const subtracks = new Map<string, XmlElement>();
  for (const timecode of indexedChildren(root, 'Timecode')) for (const track of indexedChildren(timecode, 'Track')) for (const subtrack of indexedChildren(track, 'SubTrack')) {
    subtracks.set(eventPath(timecode, track, subtrack), subtrack);
    for (const event of indexedChildren(subtrack, 'Event')) nodes.set(eventPath(timecode, track, subtrack, event), event);
  }
  const touched = new Set<XmlElement>(); const changed = new Set<string>();
  const added = new Map<number, XmlElement>();
  const nextIndices = new Map<XmlElement, number>();
  for (const subtrack of subtracks.values()) nextIndices.set(subtrack, children(subtrack, 'Event').reduce((maximum, event) => Math.max(maximum, indexOf(event) + 1), 0));
  const setCue = (node: XmlElement, reference: z.infer<typeof cueReferenceSchema>): void => {
    node.setAttribute('command', 'Goto');
    let cue = singleChild(node, 'Cue');
    if (!cue) { cue = document.createElementNS(MA_NAMESPACE, 'Cue'); node.appendChild(cue); }
    cue.setAttribute('name', reference.name);
    const existing = children(cue, 'No');
    if (existing.length && existing.length !== 3) throw new Error('Cue 引用结构不完整，禁止改写');
    for (const [index, value] of [1, reference.sequence, reference.cueIndex].entries()) {
      const no = existing[index] ?? document.createElementNS(MA_NAMESPACE, 'No');
      for (let child = no.firstChild; child; child = child.nextSibling) if (child.nodeType === 1) throw new Error('Cue 引用含未知子节点，禁止改写');
      no.textContent = String(value);
      if (!existing[index]) cue.appendChild(no);
    }
    node.setAttribute('step', String(reference.cueIndex));
  };
  const setExecutorAction = (node: XmlElement, action: 'go' | 'off'): void => {
    const cue = singleChild(node, 'Cue');
    if (cue) {
      for (let child = cue.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && ((child as XmlElement).namespaceURI !== MA_NAMESPACE || (child as XmlElement).localName !== 'No')) throw new Error('Cue 含未知扩展信息，禁止转换动作');
      }
      for (let index = 0; index < cue.attributes.length; index += 1) {
        if (cue.attributes.item(index)?.name !== 'name') throw new Error('Cue 含未知属性，禁止转换动作');
      }
      if (children(cue, 'No').some((no) => no.attributes.length > 0)) throw new Error('Cue 引用含未知属性，禁止转换动作');
      for (const no of children(cue, 'No')) for (let child = no.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1) throw new Error('Cue 引用含未知子节点，禁止转换动作');
      }
      node.removeChild(cue);
    }
    node.setAttribute('command', action === 'go' ? 'Go' : 'Off');
    node.removeAttribute('step');
  };
  const setTime = (node: XmlElement, raw: string): void => {
    if (Number(raw) === 0) node.removeAttribute('time'); else node.setAttribute('time', raw);
  };
  for (const [editIndex, edit] of edits.entries()) {
    if (edit.kind === 'add') {
      const subtrack = subtracks.get(edit.subtrackPath);
      if (!subtrack) throw new Error('新增事件的控台子轨道不存在');
      const node = document.createElementNS(MA_NAMESPACE, 'Event');
      const index = nextIndices.get(subtrack) ?? 0;
      node.setAttribute('index', String(index)); nextIndices.set(subtrack, index + 1);
      if (edit.faderLevel !== undefined) {
        assertMasterFader(subtrack, report.version);
        node.setAttribute('fader_level', edit.faderLevel);
      } else {
        if (subtrack.hasAttribute('fader_command')) throw new Error('不能向推杆子轨道写入 Cue 动作');
        node.setAttribute('command', 'Goto'); node.setAttribute('pressed', 'true');
      }
      setTime(node, edit.rawTime);
      if (edit.cue) setCue(node, edit.cue);
      if (edit.executorAction) setExecutorAction(node, edit.executorAction);
      subtrack.appendChild(node); touched.add(subtrack);
      added.set(editIndex, node);
      continue;
    }
    if (changed.has(edit.path)) throw new Error('同一事件存在重复修改');
    changed.add(edit.path);
    const node = nodes.get(edit.path);
    if (!node) throw new Error('要修改的控台事件不存在');
    const parent = node.parentNode;
    if (!parent || parent.nodeType !== 1) throw new Error('控台事件所属子轨道缺失');
    touched.add(parent as XmlElement);
    if (edit.kind === 'delete') { parent.removeChild(node); continue; }
    if ((parent as XmlElement).hasAttribute('fader_command') || node.hasAttribute('fader_level')) {
      assertMasterFader(parent as XmlElement, report.version);
      if (!faderLevelSchema.safeParse(node.getAttribute('fader_level')).success || node.hasAttribute('command') || node.hasAttribute('pressed') || singleChild(node, 'Cue')) throw new Error('推杆事件含无效或混合动作数据');
      if (edit.cue || edit.executorAction) throw new Error('推杆点不能改写为 Cue 动作');
      if (edit.faderLevel !== undefined) node.setAttribute('fader_level', edit.faderLevel);
      if (edit.rawTime !== undefined) setTime(node, edit.rawTime);
      continue;
    }
    if (edit.faderLevel !== undefined) throw new Error('Cue 动作不能改写为推杆点');
    if (!['Goto', 'Go', 'Off'].includes(node.getAttribute('command') ?? '') || node.getAttribute('pressed') !== 'true') throw new Error('此控台动作的修改尚未验证');
    if (edit.rawTime !== undefined) setTime(node, edit.rawTime);
    if (edit.cue) setCue(node, edit.cue);
    if (edit.executorAction) setExecutorAction(node, edit.executorAction);
  }
  for (const subtrack of touched) {
    const events = children(subtrack, 'Event');
    if (events.some((event) => !rawTimeSchema.safeParse(event.getAttribute('time') ?? '0').success)) throw new Error('控台事件时间无效');
    // Replace event slots rather than appending every event after extension nodes.
    const slots = events.map((event) => {
      const slot = document.createComment('event'); subtrack.replaceChild(slot, event); return slot;
    });
    events.sort((a, b) => Number(a.getAttribute('time') ?? 0) - Number(b.getAttribute('time') ?? 0));
    for (const [index, event] of events.entries()) {
      const slot = slots[index];
      if (!slot) throw new Error('控台事件排序位置缺失');
      event.setAttribute('index', String(index)); subtrack.replaceChild(event, slot);
    }
  }
  const result = new XMLSerializer().serializeToString(document);
  validateMa2TimecodeWrite(result);
  const paths = new Map<XmlElement, string>();
  for (const timecode of indexedChildren(root, 'Timecode')) for (const track of indexedChildren(timecode, 'Track')) for (const subtrack of indexedChildren(track, 'SubTrack')) {
    for (const event of indexedChildren(subtrack, 'Event')) paths.set(event, eventPath(timecode, track, subtrack, event));
  }
  const originalPaths = new Map<string, string>(); const addedPaths = new Map<number, string>();
  for (const [previous, node] of nodes) { const next = paths.get(node); if (next) originalPaths.set(previous, next); }
  for (const [index, node] of added) { const next = paths.get(node); if (!next) throw new Error('新增事件写回位置缺失'); addedPaths.set(index, next); }
  return { xml: result, originalPaths, addedPaths };
}

/** 3.3.4 and onPC 3.7.0.5 exports use 30 Hz ticks for `lenght` (200 s = 6000). */
export function extendMa2TimecodeLength(xml: string, target: number): string {
  validateMa2TimecodeWrite(xml);
  const report = inspectMa2TimecodeXml(xml);
  const timecode = report.timecodes[0];
  if (report.timecodes.length !== 1 || timecode?.index !== target - 1) throw new Error('播放长度目标与 Timecode 不一致');
  if (!['3.3.4', '3.7.0'].includes(report.version) || timecode.attributes.frame_format !== '30 FPS' || !/^\d+(?:\.\d+)?$/.test(timecode.attributes.offset ?? '0')) throw new Error('该 MA2 版本或时间基准的播放长度尚未验证');
  const length = timecode.attributes.lenght ?? '0';
  if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) throw new Error('MA2 播放长度无效，未写入控台');
  let required = 0;
  for (const track of timecode.tracks) for (const subtrack of track.subtracks) for (const event of subtrack.events) {
    const raw = event.attributes.time ?? '0';
    if (!rawTimeSchema.safeParse(raw).success) throw new Error('控台事件时间无效');
    // Leave the last event inside the playback interval, rather than exactly on its stop boundary.
    required = Math.max(required, Math.floor(Number(raw)) + 1);
  }
  if (Number(length) >= required) return xml;
  const { document, root } = parse(xml);
  indexedChildren(root, 'Timecode')[0]!.setAttribute('lenght', String(required));
  const result = new XMLSerializer().serializeToString(document);
  validateMa2TimecodeWrite(result);
  return result;
}

function assertMasterFader(subtrack: XmlElement, version: string): void {
  if (version !== '3.3.4' || subtrack.getAttribute('fader_command') !== 'Master') throw new Error('该推杆类型或 MA2 版本尚未验证');
}

function parse(xml: string) {
  if (Buffer.byteLength(xml, 'utf8') > 32 * 1024 * 1024) throw new Error('MA2 XML 超过 32 MB');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('MA2 XML 不允许 DTD 或实体声明');
  const document = new DOMParser({ onError: (_level, message) => { throw new Error(`MA2 XML 解析失败：${message}`); } }).parseFromString(xml.replace(/^\uFEFF/, ''), 'application/xml');
  const root = document.documentElement;
  if (!root || root.localName !== 'MA' || root.namespaceURI !== MA_NAMESPACE) throw new Error('不是 MA2 XML 文件');
  return { document, root };
}
function hash(xml: string): string { return createHash('sha256').update(xml, 'utf8').digest('hex'); }
function attributes(element: XmlElement): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (attribute) result[attribute.name] = attribute.value;
  }
  return result;
}
function children(element: XmlElement, name: string): XmlElement[] {
  const result: XmlElement[] = [];
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) {
      const candidate = child as XmlElement;
      if (candidate.namespaceURI === MA_NAMESPACE && candidate.localName === name) result.push(candidate);
    }
  }
  return result;
}
function indexedChildren(element: XmlElement, name: string): XmlElement[] {
  const result = children(element, name);
  const seen = new Set<number>();
  for (const entry of result) {
    const index = indexOf(entry);
    if (seen.has(index)) throw new Error(`MA2 ${name} 索引重复`);
    seen.add(index);
  }
  return result;
}
function singleChild(element: XmlElement, name: string): XmlElement | null {
  const result = children(element, name);
  if (result.length > 1) throw new Error(`MA2 ${name} 引用不唯一`);
  return result[0] ?? null;
}
function required(element: XmlElement, name: string): string {
  const value = element.getAttribute(name);
  if (value === null || value === '') throw new Error(`MA2 ${element.localName} 缺少 ${name}`);
  return value;
}
function indexOf(element: XmlElement): number {
  const value = required(element, 'index');
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('MA2 对象索引无效');
  return Number(value);
}
function address(element: XmlElement | null): string[] {
  return element ? children(element, 'No').map((child) => child.textContent ?? '') : [];
}
function eventPath(...elements: XmlElement[]): string { return elements.map((element) => `${element.localName}:${indexOf(element)}`).join('/'); }
