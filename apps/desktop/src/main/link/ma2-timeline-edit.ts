import { ma2ObjectDirectorySchema, ma2TimelineEditRequestSchema, type Ma2TimelineEditRequest, type Ma2TimelineEditResult } from '@tb/schema';
import { toConsoleLabel } from '@tb/core/link';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { editMa2TimecodeMetadata, inspectMa2TimecodeXml, sameMa2XmlObjects } from './ma2-timecode-xml';

export async function editMa2Timeline(bridge: Pick<Ma2OnpcBridge, 'request' | 'exchange'>, input: Ma2TimelineEditRequest): Promise<Ma2TimelineEditResult> {
  const request = ma2TimelineEditRequestSchema.parse(input);
  const directory = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST', 1)));
  if (directory.show !== request.expectedSource.show || directory.generation !== request.expectedSource.generation || directory.version !== request.expectedSource.version) throw new Error('控台或 Show 已改变，请刷新时间线后再修改');
  const current = await bridge.request('READ', request.target);
  const report = inspectMa2TimecodeXml(current).timecodes[0];
  if (!report || report.index + 1 !== request.target || (report.attributes.name ?? '') !== request.expectedName || Number(report.attributes.offset ?? 0) !== request.expectedOffset) throw new Error('控台时间线的名称或起始码已变化，请刷新后再修改');
  const name = toConsoleLabel(request.name);
  const desired = editMa2TimecodeMetadata(current, request.target, name, request.startMs);
  if (sameMa2XmlObjects(desired, current)) return { name, startMs: request.startMs, backupFile: null };
  const result = await bridge.exchange('APPLY', request.target, current, desired);
  if (!sameMa2XmlObjects(result.response, desired)) throw new Error('控台修改后的内容尚未确认，请刷新时间线检查');
  return { name, startMs: request.startMs, backupFile: `tblink_backup_${result.requestId}` };
}
