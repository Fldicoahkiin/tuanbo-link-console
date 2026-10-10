import { ma2RenameRequestSchema, ma2RenameResultSchema, type Ma2RenameRequest, type Ma2RenameResult } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';

export async function renameMa2Object(bridge: Pick<Ma2OnpcBridge, 'request'>, input: Ma2RenameRequest): Promise<Ma2RenameResult> {
  const request = ma2RenameRequestSchema.parse(input);
  const change = request.change;
  const endpoint = request.network ? `${request.network.host}:${request.network.port}` : '本机 onPC';
  if (endpoint !== change.endpoint) throw new Error('改名目标属于另一控台，未发送');
  const hex = (value: string) => Buffer.from(value, 'utf8').toString('hex');
  const body = [change.kind, change.cue, ...[change.show, request.generation, change.confirmedName, change.name].map(hex)].join('\n');
  let response: string;
  try { response = await bridge.request('LABEL', change.sequence, body); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Name readback differs') && /[^\x20-\x7e]/u.test(change.name)) throw new Error('控台未能保存该中文名称，请使用英文或数字。同步未确认，请读取控台核对。', { cause: error });
    if (message.includes('Console name changed')) throw new Error('读取后，控台上的名称又被修改了。请重新读取并再次确认重命名；新名称可以与原名不同。', { cause: error });
    throw error;
  }
  const result = ma2RenameResultSchema.parse(JSON.parse(response));
  if (result.sequence !== change.sequence || result.kind !== change.kind || Number(result.cue) !== Number(change.cue) || result.show !== change.show || result.generation !== request.generation || result.name !== change.name) throw new Error('控台名称回读与修改不一致，未确认同步；请读取控台核对');
  return result;
}
