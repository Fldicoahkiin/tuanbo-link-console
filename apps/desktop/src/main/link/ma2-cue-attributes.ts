import { randomBytes } from 'node:crypto';
import { cueAttributeNamesSchema, type Ma2CueAttributesRequest } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';

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

/** Keep the verified source slice on the desk for native Copy. Only this Cue's selected rows cross the wire. */
export async function readSelectedCue(bridge: Bridge, ref: {sequence: number; cue: string; attributes: string[]; includeTracking?: boolean | undefined},
  expected: Ma2CueAttributesRequest['expectedSource'], archive?: string) {
  const token = randomBytes(16).toString('hex');
  const cue = Number(ref.cue).toFixed(3);
  const source = ref.includeTracking ? 'status:' + (archive ? archive + ':' : '') : archive ? 'saved:' + archive + ':' : '';
  const query = `pick:${token}:${attributeMask(ref.attributes)}:${hex(expected.show)}-${hex(expected.generation)}:${source}${cue}`;
  const xml = await bridge.request('SEQCUES', ref.sequence, query);
  return { xml, file: 'tblink_pick_' + token };
}
