import { createHash } from 'node:crypto';
import { ma2PoolRouteSchema, type Ma2PoolRoute, type Ma2PoolRouteRequest } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';

/** The bridge checks Show/session before assigning and reuses this project's existing slot on retry. */
export async function assignMa2PoolSequence(bridge: Pick<Ma2OnpcBridge, 'request'>, request: Ma2PoolRouteRequest): Promise<Ma2PoolRoute> {
  const owner = createHash('sha256').update(request.projectId).digest('hex').slice(0, 24);
  const { show, generation } = request.expectedSource;
  const body = [owner, Buffer.from(show).toString('hex'), Buffer.from(generation).toString('hex'), 'name'].join('\n');
  const assigned = ma2PoolRouteSchema.parse(JSON.parse(await bridge.request('ASSIGNSEQ', request.sequence, body)));
  if (assigned.sequence !== request.sequence) throw new Error(`控台没有确认序列 ${request.sequence}，这次没有写入时间线`);
  return assigned;
}
