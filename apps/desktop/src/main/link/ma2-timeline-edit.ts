import { ma2TimecodeRangesSchema, ma2TimelineEditRequestSchema, type Ma2TimecodeRanges, type Ma2TimelineEditRequest, type Ma2TimelineEditResult } from '@tb/schema';
import { checkMa2MtcStart, ma2SongDirectory, toConsoleLabel } from '@tb/core/link';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { readMa2BridgeSource } from './ma2-show-probe';
import { editMa2TimecodeMetadata, inspectMa2TimecodeXml, sameMa2XmlObjects } from './ma2-timecode-xml';

export async function readMa2MtcRanges(bridge: Pick<Ma2OnpcBridge, 'request'>, signal?: AbortSignal, targets?: readonly number[]): Promise<Ma2TimecodeRanges> {
  return ma2SongDirectory(ma2TimecodeRangesSchema.parse(JSON.parse(await bridge.request('TCRANGES', 1, targets?.length ? `cueclock:${[...new Set(targets)].join(',')}` : 'editing', '', signal))));
}

export async function editMa2Timeline(bridge: Pick<Ma2OnpcBridge, 'request' | 'exchange'>, input: Ma2TimelineEditRequest): Promise<Ma2TimelineEditResult> {
  const request = ma2TimelineEditRequestSchema.parse(input);
  const directory = await readMa2BridgeSource(bridge);
  if (directory.show !== request.expectedSource.show || directory.generation !== request.expectedSource.generation || directory.version !== request.expectedSource.version) throw new Error('控台或 Show 已改变，请刷新时间线后再修改');
  const current = await bridge.request('READ', request.target);
  const report = inspectMa2TimecodeXml(current).timecodes[0];
  if (!report || report.index + 1 !== request.target || (report.attributes.name ?? '') !== request.expectedName || Number(report.attributes.offset ?? 0) !== request.expectedOffset) throw new Error('控台时间线的名称或起始码已变化，请刷新后再修改');
  const name = request.keepName ? request.expectedName : toConsoleLabel(request.name);
  const desired = editMa2TimecodeMetadata(current, request.target, name, request.startMs);
  // Move the binding's own baseline too. Any independently edited console Cues still differ from it.
  const movedBinding = request.bindingSourceXml ? { bindingSourceXml: editMa2TimecodeMetadata(request.bindingSourceXml, request.target, name, request.startMs) } : {};
  if (sameMa2XmlObjects(desired, current)) return { name, startMs: request.startMs, backupFile: null, ...movedBinding };
  if (Math.round(request.startMs * 30 / 1000) !== request.expectedOffset) {
    const ranges = await readMa2MtcRanges(bridge);
    if (ranges.show !== directory.show || ranges.generation !== directory.generation) throw new Error('控台或 Show 已改变，请刷新时间线后再修改');
    checkMa2MtcStart(ranges.entries, request.target, request.startMs, request.minimumDurationMs, false, ranges.afterRollSeconds);
  }
  const result = await bridge.exchange('APPLY', request.target, current, desired, undefined, undefined, undefined, request.expectedSource);
  if (!sameMa2XmlObjects(result.response, desired)) throw new Error('控台修改后的内容尚未确认，请刷新时间线检查');
  return { name, startMs: request.startMs, backupFile: `tblink_backup_${result.requestId}`, ...movedBinding };
}
