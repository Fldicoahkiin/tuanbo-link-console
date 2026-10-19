import type { Element as XmlElement } from '@xmldom/xmldom';
import { ma2CueContentSchema, type Ma2CueContent } from '@tb/schema';

const namespace = 'http://schemas.malighting.de/grandma2/xml/MA';
function elements(parent: XmlElement): XmlElement[] {
  const result: XmlElement[] = [];
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) result.push(child as XmlElement);
  }
  return result;
}
function properties(element: XmlElement): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < element.attributes.length; i++) {
    const attribute = element.attributes.item(i)!;
    result[attribute.name] = attribute.value;
  }
  return result;
}
function layers(element: XmlElement, prefix = ''): Ma2CueContent['rows'][number]['layers'] {
  const path = prefix ? `${prefix}/${element.localName}` : element.localName!;
  const children = elements(element);
  return [{ path, value: children.length ? '' : (element.textContent ?? '').trim(), properties: properties(element) }, ...children.flatMap(child => layers(child, path))];
}

/** Preserve exported layers and Parts. Missing payload is not proof of an empty Cue. */
export function inspectMa2CueContent(cue: XmlElement, preceding: 'none' | 'possible' | 'unverified', fullExport = false): Ma2CueContent {
  const issues = new Set<string>();
  const parts = new Set<number>();
  const index = (value: string | null): number | undefined => value !== null && /^\d+$/.test(value) && Number(value) <= 199 ? Number(value) : undefined;
  const declarations = Array.from(cue.getElementsByTagNameNS(namespace, 'CuePart'));
  for (const part of declarations) {
    const number = index(part.getAttribute('index'));
    if (number === undefined) issues.add('Cue Part 编号无法识别'); else parts.add(number);
  }
  const containers = Array.from(cue.getElementsByTagNameNS(namespace, 'CueDatas'));
  if (!containers.length && !fullExport) issues.add('没有完整 Sequence 导出的依据，缺少 CueDatas 不能据此判定为空 Cue');
  for (const child of elements(cue)) if (!['Number', 'CueDatas', 'CuePart'].includes(child.localName ?? '')) issues.add(`Cue 包含尚未支持的 ${child.localName} 数据`);
  for (const part of declarations) for (const child of elements(part)) if (!['CuePartPresetTiming', 'CueDatas', 'Command', 'Cmd'].includes(child.localName ?? '')) issues.add(`Cue Part 包含尚未支持的 ${child.localName} 数据`);
  const rows: Ma2CueContent['rows'] = [];
  for (const container of containers) for (const data of elements(container)) {
    if (data.localName !== 'CueData' || data.namespaceURI !== namespace) { issues.add('CueDatas 中存在尚未支持的数据结构'); continue; }
    const children = elements(data);
    const channels = children.filter(child => child.localName === 'Channel' && child.namespaceURI === namespace);
    if (channels.length !== 1) { issues.add('CueData 灯具属性引用缺失或重复'); continue; }
    const channel = channels[0]!;
    const attribute = channel.getAttribute('attribute_name')?.trim() ?? '';
    if (!attribute) issues.add('存在没有属性名称的数据');
    const positive = (name: string): number | undefined => {
      const value = channel.getAttribute(name);
      return value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
    };
    const fixtureId = positive('fixture_id'); const channelId = positive('channel_id');
    if (!fixtureId && !channelId) issues.add('存在无法识别的灯具或通道编号');
    const valuePart = index(data.getAttribute('value_multipart_index'));
    const effectPart = index(data.getAttribute('effect_multipart_index'));
    for (const [name, number] of [['value_multipart_index', valuePart], ['effect_multipart_index', effectPart]] as const) {
      if (number !== undefined) parts.add(number);
      else if (data.hasAttribute(name)) issues.add('属性引用的 Cue Part 编号无法识别');
    }
    const stored = children.filter(child => child !== channel).flatMap(child => layers(child));
    if (!stored.length) issues.add('属性引用没有对应的值或效果层');
    const subfixture = channel.getAttribute('subfixture_id');
    rows.push({ attribute, ...(fixtureId ? { fixtureId } : {}), ...(channelId ? { channelId } : {}), ...(subfixture ? { subfixture } : {}), ...(valuePart !== undefined ? { valuePart } : {}), ...(effectPart !== undefined ? { effectPart } : {}), layers: stored });
  }
  if (cue.getElementsByTagNameNS(namespace, 'Channel').length !== rows.length) issues.add('部分灯具属性引用位于尚未支持的数据结构');
  const hasCommands = Array.from(cue.getElementsByTagNameNS(namespace, '*')).some(element => /^(command|cmd)$/i.test(element.localName ?? '') && Boolean(element.textContent?.trim() || element.attributes.length))
    || [cue, ...declarations].some(element => Array.from(element.attributes).some(attribute => /^(command|cmd)$/i.test(attribute.name) && Boolean(attribute.value.trim())));
  // An attribute-free step may still carry triggers, fades, loops or Part timing.
  // Keep unrecognized nonempty settings out of destructive empty-Cue cleanup.
  const hasPlaybackSettings = [cue, ...declarations].some(element => Object.entries(properties(element)).some(([name,value]) => !['index','name','command','cmd'].includes(name) && Boolean(value.trim())))
    || Array.from(cue.getElementsByTagNameNS(namespace, 'CuePartPresetTiming')).some(timing => [timing, ...Array.from(timing.getElementsByTagNameNS(namespace, '*'))].some(element => element.attributes.length > 0 || elements(element).length === 0 && Boolean(element.textContent?.trim())));
  return ma2CueContentSchema.parse({ state: issues.size ? 'partial' : 'complete', issues: [...issues], parts: [...parts].sort((a,b) => a-b), rows, hasCommands, hasPlaybackSettings, tracking: preceding });
}
