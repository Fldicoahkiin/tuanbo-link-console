import { attributeMask } from './ma2-cue-attributes';
import { createHash } from 'node:crypto';
import { ma2FirstTrackReceiptSchema, type Ma2FirstTrackRequest } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';

export async function addMa2FirstTrackCues(bridge: Pick<Ma2OnpcBridge, 'request'>, request: Ma2FirstTrackRequest) {
  const { show, generation } = request.expectedSource;
  const hash = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  const owner = hash([show, request.projectId, request.itemId, request.timecode, request.executor]);
  const keys = new Set(request.points.map(point => point.id));
  if (keys.size !== request.points.length) throw new Error('本次添加的 Cue 点位重复');
  const rows = request.points.map(point => {
    const first = point.sources[0];
    const identity = point.sources.length > 1 ? [point.id, ...point.sources.map(source => [source.sequence, Number(source.cue)])] : [point.id, first?.sequence, Number(first?.cue ?? 0)];
    const modes = point.sources.map(source => source.includeTracking);
    if (modes.some(mode => mode !== undefined)) identity.push(JSON.stringify(modes));
    if (point.sources.some(source => source.attributes)) identity.push(JSON.stringify(point.sources.map(source => source.attributes && attributeMask(source.attributes))));
    const refs = point.sources.map(source => {
      const mode = source.includeTracking === undefined ? '' : source.includeTracking ? 't' : 's';
      return `${source.sequence} ${source.cue}${mode}${source.attributes ? '~' + attributeMask(source.attributes) : ''}`;
    }).join(',');
    return `${hash(identity)} ${refs || '0 0'}`;
  });
  const body = [owner, Buffer.from(show).toString('hex'), Buffer.from(generation).toString('hex'), request.executor, request.expectedSequence ?? 0, ...rows].join('\n');
  const result = ma2FirstTrackReceiptSchema.parse(JSON.parse(await bridge.request('FIRSTCUES', request.timecode, body)));
  if (result.executor !== request.executor || request.expectedSequence && result.sequence !== request.expectedSequence || result.cues.length !== rows.length) throw new Error('控台第一轨的 Cue 读回与本次写入不一致');
  return result;
}
