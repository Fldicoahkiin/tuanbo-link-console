import { ma2ExecutorPreviewSchema, ma2ExecutorReadRequestSchema, type Ma2ExecutorPreview, type Ma2ExecutorReadRequest } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { inspectMa2ExecutorXml, inspectMa2SequenceXml, validateMa2TimecodeSnapshot } from './ma2-timecode-xml';

/** Read only: never infer the executor from a relative XML offset or create console objects. */
export async function readMa2Executor(bridge: Pick<Ma2OnpcBridge, 'request'>, input: Ma2ExecutorReadRequest): Promise<Ma2ExecutorPreview> {
  const request = ma2ExecutorReadRequestSchema.parse(input);
  const [page, number] = request.executor.split('.');
  if (!page || !number) throw new Error('执行器地址缺失');
  const before = await bridge.request('EXECUTOR', Number(page), number);
  const executor = inspectMa2ExecutorXml(before);
  if (!executor.executorName) throw new Error('插件没有返回执行器名称，请更新并重新加载控台插件');
  const snapshot = await bridge.request('SCOPE', request.target, String(executor.sequence));
  validateMa2TimecodeSnapshot(snapshot, [executor.sequence]);
  const sequences = inspectMa2SequenceXml(snapshot).sequences.filter((entry) => entry.number === executor.sequence);
  if (sequences.length !== 1) throw new Error('执行器绑定的序列未完整读取');
  const after = inspectMa2ExecutorXml(await bridge.request('EXECUTOR', Number(page), number));
  if (after.version !== executor.version || after.sequence !== executor.sequence || after.assignmentName !== executor.assignmentName || after.executorName !== executor.executorName) throw new Error('读取过程中执行器的分配或名称变了，请重新读取');
  return ma2ExecutorPreviewSchema.parse({ target: request.target, executor: request.executor, assignmentName: executor.assignmentName, executorName: executor.executorName, readAt: new Date().toISOString(), cueCatalog: sequences.map((sequence) => ({ sequence: sequence.number, name: sequence.name, cues: [...sequence.cues].sort((a, b) => a.index - b.index) })) });
}
