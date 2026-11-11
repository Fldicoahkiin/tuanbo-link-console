import { randomUUID } from 'node:crypto';
import { holdForShow, isShowWait, type ShowGateReader, type ShowOperation } from '@tb/core/link';
import { ma2ExecutorPageDirectorySchema } from '@tb/schema';
import { inspectMa2ExecutorPageXml } from './ma2-timecode-xml';
import { ma2ObjectDirectorySchema, ma2SequenceAssignmentSchema, ma2RenameResultSchema, ma2LabelSchema, ma2TimecodeRangesSchema } from '@tb/schema';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { inspectMa2SequenceXml, inspectMa2ExecutorXml, inspectMa2TimecodeXml, referencedMa2Sequences, sameMa2XmlObjects, validateMa2TimecodeSnapshot, validateMa2TimecodeWrite } from './ma2-timecode-xml';
export type Ma2Operation = 'PING' | 'PAGES' | 'PAGE' | 'LIST' | 'LISTSEQ' | 'SEQUENCE' | 'SEQCUES' | 'READ' | 'SNAPSHOT' | 'SCOPE' | 'APPLY' | 'SYNC' | 'CREATE' | 'EXECUTOR' | 'ASSIGNSEQ' | 'LABEL' | 'DISCARD' | 'TCRANGES';
/** Fires after every acknowledged line of a long transfer; response reads also say how many bytes have arrived. */
export type Ma2TransferProgress = (download?: { completed: number; total: number }) => void;
/** The plugin's two request slots (M4): 'bg' for syncs and long reads, 'fg' for a short read an operator waits for. */
export type Ma2Lane = 'bg' | 'fg';
export type Ma2Wire = {
  /** `beforeStep` runs before each plugin step (the first included) with the steps done so far; throwing stops there
   * and releases the request. `lane`: the plugin slot the request takes ('bg' when left out). */
  exchange(id: string, operation: Ma2Operation, target: number, body: string, beforeSend: () => void, signal?: AbortSignal, progress?: Ma2TransferProgress, beforeStep?: (done: number) => void | Promise<void>, lane?: Ma2Lane): Promise<string>;
  /** True once the running plugin is known to keep a foreground lane; false or null (not known yet): one lane only. */
  readonly lanes?: boolean | null;
};

/**
 * Which lane a request takes when the plugin has two (M4, 03 §4.2.1). Foreground: reads only, short (one or a few
 * steps, no large answer) and someone waits for them on screen: the executor page being looked at and the page list,
 * one executor read before a key press, the version check, and the Timecode and Sequence directories (the live
 * session checks the latter every 5 s, the page view and every catalog read start with one). Everything that writes
 * the console stays in the background and never jumps the queue, so a rename cannot make a sync's snapshot check
 * fail midway; so do the long reads (a Timecode show, a Sequence, the snapshots a sync rests on, the Timecode ranges)
 * and DISCARD, which removes files. The plugin refuses anything else on 'fg'.
 */
export function ma2Lane(operation: Ma2Operation): Ma2Lane {
  switch (operation) {
    case 'PING': case 'PAGES': case 'PAGE': case 'LIST': case 'LISTSEQ': case 'EXECUTOR': return 'fg';
    case 'SEQUENCE': case 'SEQCUES': case 'READ': case 'SNAPSHOT': case 'SCOPE': case 'TCRANGES': case 'DISCARD':
    case 'APPLY': case 'SYNC': case 'CREATE': case 'ASSIGNSEQ': case 'LABEL': return 'bg';
  }
}

/**
 * What the show must allow before each plugin step of `operation` (M3, 第 3 题): writing the console waits as a sync,
 * a page refresh as one, every other read as reading the console. Null: at any time (the version check, removing
 * rotated-out backups). The rules themselves are showGate's (show-state.ts); this only says which one a request is.
 */
export function ma2StepGate(operation: Ma2Operation): ShowOperation | null {
  switch (operation) {
    case 'APPLY': case 'SYNC': case 'CREATE': case 'ASSIGNSEQ': case 'LABEL': return 'ma2.sync.write';
    case 'PAGE': case 'PAGES': return 'ma2.executorPage.refresh';
    case 'LIST': case 'LISTSEQ': case 'SEQUENCE': case 'SEQCUES': case 'READ': case 'SNAPSHOT': case 'SCOPE': case 'EXECUTOR': case 'TCRANGES': return 'ma2.sync.read';
    case 'PING': case 'DISCARD': return null;
  }
}

/**
 * The plugin step that writes the console, counted from 1, as tools/ma2/tblink_bridge.lua lays the request out:
 * APPLY and CREATE write in their first step, SYNC after its preflight (the Timecode export, two exports for each
 * Sequence it references or will reference, the Timecode check). The step after it reads the write back, and a
 * program that starts moving never holds that one: a request either stops before its write or ends confirmed, so
 * the console is never left written and unconfirmed by a stop. A miscount is safe: the plugin writes only when the
 * Timecode is still the one `expected` holds, and then it references exactly these Sequences. Null: no write, one
 * step only (LABEL), or a write at a step the program cannot know (ASSIGNSEQ's search, which finds its own
 * assignment again when it runs once more).
 */
export function ma2WriteStep(operation: Ma2Operation, expected: string, desired: string): number | null {
  switch (operation) {
    case 'APPLY': case 'CREATE': return 1;
    case 'SYNC': return 2 * new Set([...referencedMa2Sequences(expected), ...referencedMa2Sequences(desired)]).size + 3;
    default: return null;
  }
}
/** PING answers the console version; a plugin that works step by step adds a line `steps=1`. */
export function parseMa2Ping(response: string): { version: string; steps: boolean } {
  const match = /^([^\n]+)(\nsteps=1)?$/.exec(response);
  if (!match) throw new Error('控台连接组件的版本回答无法识别');
  return { version: match[1]!, steps: match[2] !== undefined };
}
/** What a request stopped for the show leaves behind, after the wait's own words (they come first: isShowWait). */
function ma2StepWaitDetail(operation: Ma2Operation, done: number, writeStep: number | null): string {
  if (done === 0) return '这一步没有发给控台。';
  if (writeStep !== null) return '控台上还没有写入，接着同步时会重新读取控台再写。';
  if (operation === 'ASSIGNSEQ') return '执行器可能已经放好了，接着同步时会重新核对，不会放第二次。';
  return '读到一半停下了，接着会重新读取。';
}
export class Ma2BridgeFailure extends Error {
  constructor(message: string, readonly requestId: string, readonly sent: boolean, options: ErrorOptions, readonly backupFile: string | null = null) { super(message, options); }
}

type Ma2LaneQueue = { tail: Promise<void>; queued: number; epoch: number };

/** One request at a time on each plugin lane; timeout is an uncertain outcome and is never retried. */
export class Ma2OnpcBridge {
  // Each lane is its own queue: a failure cancels what waits on its own lane only. A plugin with one lane
  // (from before M4, or not known yet) and the local file bridge get everything on 'bg'.
  private readonly queues: Record<Ma2Lane, Ma2LaneQueue> = { bg: { tail: Promise.resolve(), queued: 0, epoch: 0 }, fg: { tail: Promise.resolve(), queued: 0, epoch: 0 } };
  /** `show`: asked again right before a write or an assignment goes on the wire, and before every further plugin step
   * of any request (ma2StepGate). The local file bridge runs a request in one go and has no step to stop at. */
  constructor(private readonly dataDirectory: string | Ma2Wire, private readonly show: ShowGateReader) {
    if (typeof dataDirectory === 'string' && !isAbsolute(dataDirectory)) throw new Error('MA2 数据目录必须是绝对路径');
  }
  /** `behind: 'bg'` queues a foreground read behind the background lane anyway: a read that a console change made
   * straight on the Telnet line follows, so that change waits for a running sync instead of jumping ahead of it. */
  async request(operation: Ma2Operation, target: number, expected = '', desired = '', signal?: AbortSignal, progress?: Ma2TransferProgress, behind?: 'bg'): Promise<string> {
    return (await this.exchange(operation, target, expected, desired, signal, progress, behind)).response;
  }
  async exchange(operation: Ma2Operation, target: number, expected = '', desired = '', signal?: AbortSignal, progress?: Ma2TransferProgress, behind?: 'bg'): Promise<{ response: string; requestId: string }> {
    signal?.throwIfAborted();
    const lane: Ma2Lane = typeof this.dataDirectory !== 'string' && this.dataDirectory.lanes === true ? behind ?? ma2Lane(operation) : 'bg';
    const queue = this.queues[lane];
    if (queue.queued >= 32) throw new Error('控台操作太多，请等当前操作完成');
    const epoch = queue.epoch;
    queue.queued += 1;
    const result = queue.tail.then(async () => {
      if (epoch !== queue.epoch) throw new Error('上一个控台操作没完成，排队的操作已取消');
      try { return await this.performExchange(operation, target, expected, desired, signal, progress, lane); }
      catch (error) {
        // A request that stopped for the show is no uncertain outcome: what waits behind it meets the same gate itself.
        if (!isShowWait(error)) queue.epoch += 1;
        throw error;
      }
    }).finally(() => { queue.queued -= 1; });
    // Serialize the entire transaction on its lane, including all chunks and response release.
    // Scheduling consumes rejection only internally; callers retain the original error.
    queue.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private async performExchange(operation: Ma2Operation, target: number, expected: string, desired: string, signal: AbortSignal | undefined, progress: Ma2TransferProgress | undefined, lane: Ma2Lane): Promise<{ response: string; requestId: string }> {
    signal?.throwIfAborted();
    if (!Number.isInteger(target) || target < 1 || target > 99999) throw new Error('Timecode 编号无效');
    const writing = operation === 'APPLY' || operation === 'SYNC' || operation === 'CREATE';
    const assigning = operation === 'ASSIGNSEQ' || operation === 'LABEL';
    if (operation === 'LABEL') {
      const parts = expected.split('\n');
      if (desired || parts.length !== 6 || !['single', 'sequence'].includes(parts[0]!) || !/^\d+(?:\.\d{1,3})?$/.test(parts[1]!) || parts.slice(2).some(value => !/^(?:[a-f0-9]{2})*$/.test(value)) || expected.length > 16384) throw new Error('控台改名请求格式无效');
      ma2LabelSchema.parse(Buffer.from(parts[5]!, 'hex').toString('utf8'));
    }
    if (operation === 'ASSIGNSEQ' && (!/^[a-f0-9]{24}\n(?:[a-f0-9]{2}){1,4096}\n(?:[a-f0-9]{2}){1,256}$/.test(expected) || desired)) throw new Error('自动关联请求格式无效');
    // Writing the Timecode show, renaming and assigning a Sequence are all syncing the console (第 3 题).
    const hold = (reached = ''): void => { if (writing || assigning) holdForShow(this.show, 'ma2.sync.write', reached); };
    hold();
    if (operation === 'SEQUENCE' && (!['', 'keep'].includes(expected) || desired)) throw new Error('序列读取请求格式无效');
    if (operation === 'SEQCUES' && (!/^\d+\.\d{3}(?:,\d+\.\d{3})*$/.test(expected) || expected.length > 65536 || desired)) throw new Error('序列 Cue 读取范围无效');
    if (operation === 'TCRANGES' && (target !== 1 || expected || desired)) throw new Error('时间码范围读取请求格式无效');
    if (operation === 'DISCARD' && (!/^tblink_(?:backup|label|library)_[a-f0-9]{32}(?:,tblink_(?:backup|label|library)_[a-f0-9]{32})*$/.test(expected) || expected.length > 4096 || desired)) throw new Error('控台备份清理列表无效');
    if (operation === 'EXECUTOR' && (!/^[1-9]\d*$/.test(expected) || Number(expected) > 99999 || desired !== '')) throw new Error('执行器编号无效');
    const requestedSequences = operation === 'SCOPE' ? expected.split(',').map(Number) : [];
    if (operation === 'SCOPE' && (!/^[1-9]\d*(?:,[1-9]\d*)*$/.test(expected) || requestedSequences.some((number) => !Number.isInteger(number) || number > 99999) || new Set(requestedSequences).size !== requestedSequences.length)) throw new Error('额外序列读取范围无效');
    if (writing) {
      if (operation === 'CREATE' && expected !== '') throw new Error('新建 Timecode 不能包含旧对象快照');
      for (const [index, xml] of [expected, desired].entries()) {
        if (operation === 'CREATE' && index === 0) continue;
        if (operation === 'SYNC' && index === 0) validateMa2TimecodeSnapshot(xml, referencedMa2Sequences(desired)); else validateMa2TimecodeWrite(xml);
        const report = inspectMa2TimecodeXml(xml);
        if (report.timecodes.length !== 1 || report.timecodes[0]?.index !== target - 1) throw new Error('XML 必须只包含绑定的 Timecode 对象');
        if (operation === 'CREATE' && (report.timecodes[0].tracks.length || report.timecodes[0].attributes.frame_format !== '30 FPS' || Number(report.timecodes[0].attributes.offset ?? 0) !== 0)) throw new Error('新建 Timecode 必须为空且使用已验证的 30 FPS');
      }
    }
    const id = randomUUID().replaceAll('-', '');
    let sent = false;
    try {
      const body = writing ? `${Buffer.byteLength(expected)}\n${expected}${desired}` : operation === 'EXECUTOR' || operation === 'SEQCUES' || operation === 'SEQUENCE' || operation === 'DISCARD' || assigning ? expected : operation === 'SCOPE' ? requestedSequences.sort((a, b) => a - b).join(',') : '';
      if (Buffer.byteLength(body) > 32 * 1024 * 1024) throw new Error('MA2 交换数据超过 32 MB');
      const validate = (result: string): { response: string; requestId: string } => {
        if (operation === 'PING') return { response: parseMa2Ping(result).version, requestId: id };
        if (operation === 'LABEL') { const label = ma2RenameResultSchema.parse(JSON.parse(result)); if (label.sequence !== target) throw new Error('控台名称回读序列不一致'); }
        else if (assigning) { const assigned = ma2SequenceAssignmentSchema.parse(JSON.parse(result)); if (assigned.sequence !== target) throw new Error('控台自动关联序列不一致'); }
        else if (operation === 'PAGES') ma2ExecutorPageDirectorySchema.parse(JSON.parse(result));
        else if (operation === 'PAGE') inspectMa2ExecutorPageXml(result, target);
        else if (operation === 'LIST' || operation === 'LISTSEQ') ma2ObjectDirectorySchema.parse(JSON.parse(result));
        else if (operation === 'SEQUENCE' || operation === 'SEQCUES') {
          const report = inspectMa2SequenceXml(result);
          if (report.sequences.length !== 1 || report.sequences[0]?.number !== target) throw new Error('Sequence 回读对象不一致');
        }
        else if (operation === 'EXECUTOR') inspectMa2ExecutorXml(result);
        else if (operation === 'TCRANGES') ma2TimecodeRangesSchema.parse(JSON.parse(result));
        else if (operation === 'DISCARD') { if (result.split(',').some(name => name && !expected.split(',').includes(name))) throw new Error('控台备份清理回执与请求不一致'); }
        else {
          if (operation === 'SNAPSHOT' || operation === 'SCOPE') validateMa2TimecodeSnapshot(result, requestedSequences);
          else validateMa2TimecodeWrite(result);
          const report = inspectMa2TimecodeXml(result);
          if (report.timecodes.length !== 1 || report.timecodes[0]?.index !== target - 1) throw new Error('控台读回的对象和绑定的 Timecode 对不上，同步没有确认');
        }
        if (writing && !sameMa2XmlObjects(desired, result)) throw new Error('写入后控台读回的内容和预期不一致，同步没有完成，备份已保留。请重新读取控台，检查引用和事件');
        return { response: result, requestId: id };
      };
      if (typeof this.dataDirectory !== 'string') {
        // M3: a program that starts moving stops the request at the next step boundary. The step on the console
        // finishes (a step cannot be cut short), the next one is not sent and the wire releases the request at once.
        const gate = ma2StepGate(operation);
        const writeStep = ma2WriteStep(operation, expected, desired);
        const stopped: { at: number | null } = { at: null };
        const beforeStep = async (done: number): Promise<void> => {
          // M4: before each background step, the foreground requests queued by now are done whole. Not before the
          // read-back that follows the write, which goes straight on; foreground requests only read, under names of
          // their own, so one that runs meanwhile changes nothing the read-back sees.
          if (lane === 'bg' && done !== writeStep) await this.queues.fg.tail;
          if (gate === null || done === writeStep) return;
          try { holdForShow(this.show, gate, ma2StepWaitDetail(operation, done, writeStep)); }
          catch (wait) { stopped.at = done; throw wait; }
        };
        try {
          return validate(await this.dataDirectory.exchange(id, operation, target, body, () => {
            hold('这一步没有发给控台。');
            sent = true;
          }, signal, progress, beforeStep, lane));
        } catch (error) {
          // Stopped before its write step: the console holds what it held, so the write was never sent.
          if (error instanceof Ma2BridgeFailure && stopped.at !== null && writeStep !== null && stopped.at < writeStep) {
            throw new Ma2BridgeFailure(error.message, id, false, { cause: error.cause }, error.backupFile);
          }
          throw error;
        }
      }
      const directory = join(this.dataDirectory, 'temp');
      for (const name of ['temp', 'plugins', 'importexport']) {
        if (!(await stat(join(this.dataDirectory, name))).isDirectory()) throw new Error('MA2 数据目录不完整');
      }
      const temporary = join(directory, `tblink_request_${id}.tmp`);
      signal?.throwIfAborted();
      await writeFile(temporary, `${id}\n${operation}\n${target}\n${Buffer.byteLength(body)}\n${body}`, 'utf8');
      hold('这一步没有发给控台。');
      await rename(temporary, join(directory, 'tblink_bridge_request.txt'));
      sent = true;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        let response: string | null = null;
        try { response = await readFile(join(directory, 'tblink_bridge_response.txt'), 'utf8'); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
        if (response) {
          const match = /^([a-f0-9]{32})\n(OK|ERROR)\n(\d+)\n([\s\S]*)$/.exec(response);
          if (match?.[1] === id && Buffer.byteLength(match[4] ?? '') === Number(match[3])) {
            if (match[2] === 'ERROR') throw new Error(`MA2：${match[4]}`);
            const result = match[4] ?? '';
            return validate(result);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('MA2 插件响应超时，同步没有确认，不会自动重试。请检查插件和控台上的数据');
    } catch (error) {
      if (error instanceof Ma2BridgeFailure) throw error;
      let message = error instanceof Error ? error.message : String(error);
      let backupFile: string | null = null;
      if (typeof this.dataDirectory === 'string' && sent && (operation === 'APPLY' || operation === 'SYNC')) {
        const name = `tblink_backup_${id}.xml`;
        try {
          const backup = await readFile(join(this.dataDirectory, 'importexport', name), 'utf8');
          validateMa2TimecodeWrite(backup);
          const report = inspectMa2TimecodeXml(backup);
          if (report.timecodes.length !== 1 || report.timecodes[0]?.index !== target - 1) throw new Error('备份 Timecode 与同步目标不一致');
          backupFile = name;
        } catch (backupError) {
          if (!(backupError instanceof Error && 'code' in backupError && backupError.code === 'ENOENT')) message += `；备份检查失败：${backupError instanceof Error ? backupError.message : String(backupError)}`;
        }
      }
      throw new Ma2BridgeFailure(message, id, sent, { cause: error }, backupFile);
    }
  }
}
