import { ma2RenameRequestSchema, ma2RenameResultSchema, type Ma2RenameRequest, type Ma2RenameResult } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { toConsoleLabel } from '@tb/core/link';

export async function renameMa2Object(bridge: Pick<Ma2OnpcBridge, 'request'>, input: Ma2RenameRequest): Promise<Ma2RenameResult> {
  const request = ma2RenameRequestSchema.parse(input);
  const change = request.change;
  if (change.name === '') throw new Error('原来的 Cue 没有名称。请在控台上清除这个名称后重新读取；这次撤销还没同步，没有发送清除指令');
  const endpoint = request.network ? `${request.network.host}:${request.network.port}` : '本机 onPC';
  if (endpoint !== change.endpoint) throw new Error('要改名的对象属于另一个控台，没有发送');
  const hex = (value: string) => Buffer.from(value, 'utf8').toString('hex');
  const label = toConsoleLabel(change.name);
  const body = [change.kind, change.cue, ...[change.show, request.generation, change.confirmedName, label].map(hex)].join('\n');
  let response: string;
  try { response = await bridge.request('LABEL', change.sequence, body); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Console name changed')) throw new Error('读取后，控台上的名称又被修改了。请重新读取并再次确认重命名；新名称可以与原名不同。', { cause: error });
    throw error;
  }
  const result = ma2RenameResultSchema.parse(JSON.parse(response));
  if (result.sequence !== change.sequence || result.kind !== change.kind || Number(result.cue) !== Number(change.cue) || result.show !== change.show || result.generation !== request.generation || result.name !== label) throw new Error('控台上的名称和修改的不一致，同步没有确认，请读取控台检查');
  return result;
}
