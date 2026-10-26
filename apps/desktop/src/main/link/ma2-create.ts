import { DOMImplementation, XMLSerializer } from '@xmldom/xmldom';
import { type Ma2TimecodePreview } from '@tb/schema';
import { convertMa2Timecode } from './ma2-timecode-conversion';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { toConsoleLabel } from '@tb/core/link';

export function createMa2TimecodeXml(target: number, name: string, version: string): string {
  if (!Number.isInteger(target) || target < 1 || target > 99999) throw new Error('Timecode 编号应为 1–99999');
  if (!name.trim() || name.length > 512 || /[\u0000-\u001f]/.test(name)) throw new Error('Timecode 名称无效');
  if (!/^3\.(?:3\.4|7\.0)(?:\.\d+)?$/.test(version)) throw new Error('这个 MA2 版本还没验证过 Timecode 创建');
  const namespace = 'http://schemas.malighting.de/grandma2/xml/MA';
  const document = new DOMImplementation().createDocument(namespace, 'MA', null);
  const root = document.documentElement;
  if (!root) throw new Error('无法创建 MA2 XML 根节点');
  for (const [index, attribute] of ['major_vers', 'minor_vers', 'stream_vers'].entries()) root.setAttribute(attribute, version.split('.')[index]!);
  const timecode = document.createElementNS(namespace, 'Timecode');
  timecode.setAttribute('index', String(target - 1)); timecode.setAttribute('name', name);
  timecode.setAttribute('slot', 'TC Slot 1'); timecode.setAttribute('frame_format', '30 FPS');
  root.appendChild(timecode);
  return new XMLSerializer().serializeToString(document);
}

export async function createMa2Timecode(bridge: Pick<Ma2OnpcBridge, 'request'>, target: number, name: string): Promise<Ma2TimecodePreview> {
  const version = await bridge.request('PING', target);
  const xml = createMa2TimecodeXml(target, toConsoleLabel(name), version);
  const confirmed = await bridge.request('CREATE', target, '', xml);
  return convertMa2Timecode(confirmed, [], target);
}
