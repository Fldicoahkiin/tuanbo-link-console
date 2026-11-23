import { randomBytes } from 'node:crypto';
import { cueAttributeNamesSchema, ma2CueValueEditsSchema, type Ma2CueAttributesRequest, type Ma2WriteCueValuesRequest, type Ma2CueValueEdit, type Ma2CueValueRow } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';

import { inspectMa2CueAttributes } from './ma2-timecode-xml';

type Bridge = Pick<Ma2OnpcBridge, 'request'>;
const hex = (value: string): string => Buffer.from(value).toString('hex');

export function attributeMask(attributes: string[]): string {
  if (!attributes.length) throw new Error('请至少选择一项灯光属性，或在时间线上添加空 Cue');
  return attributes.map(hex).sort().join('+');
}

export async function readCueAttributeNames(bridge: Bridge, request: Ma2CueAttributesRequest): Promise<string[]> {
  const source = request.expectedSource;
  const query = `names:${hex(source.show)}:${hex(source.generation)}:${request.includeTracking ? 'status:' : ''}${Number(request.cue).toFixed(3)}`;
  const reply = await bridge.request('SEQCUES', request.sequence, query);
  if (!/^attributes:(?:[a-f0-9]+(?:,[a-f0-9]+)*)?$/.test(reply)) throw new Error('控台没有返回这个 Cue 的属性清单');
  return cueAttributeNamesSchema.parse(reply.slice(11).split(',').filter(Boolean).map(name => Buffer.from(name, 'hex').toString('utf8')));
}

export function encodeCueValueEdits(edits: Ma2CueValueEdit[]): string {
  return ma2CueValueEditsSchema.parse(edits).map(edit => `${edit.key},${edit.before},${edit.value};`).sort().join('');
}

export async function readCueValues(bridge: Bridge, request: Ma2CueAttributesRequest): Promise<Ma2CueValueRow[]> {
  const { show, generation } = request.expectedSource;
  const query = `values:${hex(show)}:${hex(generation)}:${request.includeTracking ? 'status:' : ''}${Number(request.cue).toFixed(3)}`;
  const xml = await bridge.request('SEQCUES', request.sequence, query);
  const result = inspectMa2CueAttributes(xml, new Date().toISOString(), true);
  if (result.length !== 1 || result[0]?.sequence !== request.sequence || !result[0].content) throw new Error('控台返回的 Cue 与所选素材不一致');
  return result[0].content.rows.map(row => {
    const key = [row.fixtureId, row.channelId, hex(row.subfixture ?? ''), row.valuePart, hex(row.attribute)].join('/');
    const fixture = [row.fixtureId && `灯具 ${row.fixtureId}`, row.channelId && `通道 ${row.channelId}`, row.subfixture && `子灯具 ${row.subfixture}`, row.valuePart && `Part ${row.valuePart}`].filter(Boolean).join(' · ');
    const stored = row.layers.find(layer => layer.path === 'Value');
    const preset = row.layers.find(layer => layer.path === 'Preset');
    return { key, fixture, attribute: row.attribute, value: stored?.value || row.layers.map(layer => layer.path.split('/')[0]).filter((name, i, all) => all.indexOf(name) === i).join(' / '), preset: preset?.properties.name ?? '' };
  });
}

export async function writeOriginalCueValues(bridge: Bridge, request: Ma2WriteCueValuesRequest): Promise<string> {
  const { show, generation } = request.expectedSource;
  const body = [hex(show), hex(generation), Number(request.cue).toFixed(3), encodeCueValueEdits(request.edits)].join('\n');
  return bridge.request('SETVALUES', request.sequence, body);
}

/** Keep the verified source slice on the desk for native Copy. Only this Cue's selected rows cross the wire. */
export async function readSelectedCue(bridge: Bridge, ref: {sequence: number; cue: string; attributes?: string[] | undefined; valueEdits?: Ma2CueValueEdit[] | undefined; includeTracking?: boolean | undefined},
  expected: Ma2CueAttributesRequest['expectedSource'], archive?: string) {
  const token = randomBytes(16).toString('hex');
  const cue = Number(ref.cue).toFixed(3);
  const source = ref.includeTracking ? 'status:' + (archive ? archive + ':' : '') : archive ? 'saved:' + archive + ':' : '';
  const mask = ref.attributes ? attributeMask(ref.attributes) : 'all';
  const changes = ref.valueEdits ? '!' + hex(encodeCueValueEdits(ref.valueEdits)) : '';
  const query = `pick:${token}:${mask}${changes}:${hex(expected.show)}-${hex(expected.generation)}:${source}${cue}`;
  const xml = await bridge.request('SEQCUES', ref.sequence, query);
  return { xml, file: 'tblink_pick_' + token };
}
