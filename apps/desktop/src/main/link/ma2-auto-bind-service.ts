import { createHash } from 'node:crypto';
import { ma2AutoBindEvents } from '@tb/core/link';
import { ma2AutoBindRequestSchema, ma2AutoBindResultSchema, ma2ObjectDirectorySchema, ma2SequenceAssignmentSchema, type Ma2AutoBindRequest, type Ma2AutoBindResult } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { createMa2Timecode } from './ma2-create';
import { convertMa2Snapshot } from './ma2-timecode-conversion';
import { recoverMa2AutoBinding } from './ma2-auto-bind-recovery';
import { inspectMa2ExecutorXml } from './ma2-timecode-xml';

/** Provision only empty slots. Existing user assignments and Sequence contents are never rewritten. */
export async function prepareMa2AutoBindings(bridge: Pick<Ma2OnpcBridge, 'request'>, input: Ma2AutoBindRequest, isPlaying: () => boolean): Promise<Ma2AutoBindResult> {
  const request = ma2AutoBindRequestSchema.parse(input);
  const stopped = () => { if (isPlaying()) throw new Error('播放中暂存修改，停止后自动同步'); };
  stopped();
  const directory = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST', 1)));
  if (Object.entries(request.expectedSource).some(([key, value]) => Reflect.get(directory, key) !== value)) throw new Error('控台 Show 或会话已变化，未自动创建关联');
  const events = ma2AutoBindEvents(request.document);
  const editable = request.document.ma2Bindings?.filter(binding => !binding.nativeEvents?.length && binding.playback !== 'native-timecode') ?? [];
  const owner = createHash('sha256').update(request.projectId).digest('hex').slice(0, 24);
  const song = createHash('sha256').update(`${request.projectId}:${request.itemId}`).digest('hex').slice(0, 24);
  const name = `TBLINK_${song}`;
  let binding = editable.length === 1 ? editable[0] : editable.find(entry => entry.name === name);
  let newBinding: NonNullable<Ma2AutoBindResult['plan']['newBinding']> | undefined;
  let recovered: Ma2AutoBindResult['plan'] | undefined;
  if (!binding) {
    // MA2 getobj.name includes the object number; exported XML keeps the label only.
    const matches = directory.entries.filter(entry => entry.name === name || entry.name === `${name} ${entry.target}`);
    if (matches.length > 1) throw new Error('控台存在重复的软件时间线，未选择或覆盖对象');
    let preview;
    if (matches[0]) {
      preview = convertMa2Snapshot(await bridge.request('SNAPSHOT', matches[0].target), matches[0].target);
      if (preview.name !== name) throw new Error('专用时间线名称与回读不一致，未覆盖对象');
      if (preview.document.tracks.length || preview.unconverted.length) recovered = recoverMa2AutoBinding(request.document, preview, `ma2-managed:${song}`);
      const verified = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST', 1)));
      if (Object.entries(request.expectedSource).some(([key, value]) => Reflect.get(verified, key) !== value)) throw new Error('恢复期间控台 Show 或会话已变化，未采用关联');
    } else {
      const occupied = new Set(directory.entries.map(entry => entry.target));
      let target = 9999; while (occupied.has(target) && target > 1) target--;
      if (occupied.has(target)) throw new Error('控台没有可用的时间线位置');
      stopped(); preview = await createMa2Timecode(bridge, target, name);
      const updated = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST', 1)));
      if (updated.show !== directory.show || updated.generation !== directory.generation || updated.version !== directory.version) throw new Error('创建期间 Show 或会话已变化，请重新读取');
      directory.entries = updated.entries;
    }
    newBinding = recovered?.newBinding ?? { id: `ma2-managed:${song}`, timecode: preview.target, name: preview.name, readAt: preview.readAt,
      sourceXml: preview.sourceXml, baselineTracks: [], mappings: [], trackMappings: [], nativeEvents: [], playback: 'editable' };
    binding = newBinding;
  }
  const assignments: Ma2AutoBindResult['plan']['assignments'] = recovered?.assignments ?? [];
  const known = new Map<string, ReturnType<typeof inspectMa2ExecutorXml>>();
  for (const assignment of assignments) {
    const [page, slot] = assignment.executor.split('.');
    const assigned = inspectMa2ExecutorXml(await bridge.request('EXECUTOR', Number(page), slot));
    if (assigned.sequence !== assignment.sequence || !assigned.executorName) throw new Error(`执行器 ${assignment.executor} 的序列已改变，未恢复关联`);
    assignment.executorName = assigned.executorName; known.set(assignment.executor, assigned);
  }
  for (const event of events) {
    let executor = event.executor;
    if (!executor) {
      if (event.kind !== 'ma2' || !event.sequence) throw new Error('Cue 缺少序列引用');
      const existing = assignments.find(entry => entry.pool && entry.sequence === event.sequence);
      if (existing) continue;
      stopped();
      const body = `${owner}\n${Buffer.from(directory.show).toString('hex')}\n${Buffer.from(directory.generation).toString('hex')}`;
      const result = ma2SequenceAssignmentSchema.parse(JSON.parse(await bridge.request('ASSIGNSEQ', event.sequence, body)));
      if (result.sequence !== event.sequence) throw new Error('控台自动关联返回了不同序列');
      executor = result.executor;
    }
    const [page, number] = executor.split('.');
    const assigned = known.get(executor) ?? inspectMa2ExecutorXml(await bridge.request('EXECUTOR', Number(page), number));
    if (!assigned.executorName || event.kind === 'ma2' && event.action === 'goto' && assigned.sequence !== event.sequence) throw new Error(`执行器 ${executor} 的序列引用不一致，未写入时间线`);
    if (known.has(executor) && event.executor) continue;
    known.set(executor, assigned);
    assignments.push({ sequence: assigned.sequence, executor, executorName: assigned.executorName, pool: !event.executor });
  }
  return ma2AutoBindResultSchema.parse({ directory, plan: { bindingId: binding.id, ...(newBinding ? { newBinding } : {}), assignments } });
}
