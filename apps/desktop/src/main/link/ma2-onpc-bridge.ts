import { randomUUID } from 'node:crypto';
import { ma2ExecutorPageDirectorySchema } from '@tb/schema';
import { inspectMa2ExecutorPageXml } from './ma2-timecode-xml';
import { ma2ObjectDirectorySchema, ma2SequenceAssignmentSchema, ma2RenameResultSchema, ma2LabelSchema, ma2TimecodeRangesSchema } from '@tb/schema';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { inspectMa2SequenceXml, inspectMa2ExecutorXml, inspectMa2TimecodeXml, referencedMa2Sequences, sameMa2XmlObjects, validateMa2TimecodeSnapshot, validateMa2TimecodeWrite } from './ma2-timecode-xml';
export type Ma2Operation = 'PING' | 'PAGES' | 'PAGE' | 'LIST' | 'LISTSEQ' | 'SEQUENCE' | 'SEQCUES' | 'READ' | 'SNAPSHOT' | 'SCOPE' | 'APPLY' | 'SYNC' | 'CREATE' | 'EXECUTOR' | 'ASSIGNSEQ' | 'LABEL' | 'DISCARD' | 'TCRANGES';
/** Fires after every acknowledged line of a long transfer; response reads also say how many bytes have arrived. */
export type Ma2TransferProgress = (download?: { completed: number; total: number }) => void;
export type Ma2Wire = {
  exchange(id: string, operation: Ma2Operation, target: number, body: string, beforeSend: () => void, signal?: AbortSignal, progress?: Ma2TransferProgress): Promise<string>;
};
export class Ma2BridgeFailure extends Error {
  constructor(message: string, readonly requestId: string, readonly sent: boolean, options: ErrorOptions, readonly backupFile: string | null = null) { super(message, options); }
}

/** One request at a time; timeout is an uncertain outcome and is never retried. */
export class Ma2OnpcBridge {
  private exchangeTail: Promise<void> = Promise.resolve();
  private queuedExchanges = 0;
  private exchangeEpoch = 0;
  constructor(private readonly dataDirectory: string | Ma2Wire, private readonly isPlaying: () => boolean) {
    if (typeof dataDirectory === 'string' && !isAbsolute(dataDirectory)) throw new Error('MA2 数据目录必须是绝对路径');
  }
  async request(operation: Ma2Operation, target: number, expected = '', desired = '', signal?: AbortSignal, progress?: Ma2TransferProgress): Promise<string> {
    return (await this.exchange(operation, target, expected, desired, signal, progress)).response;
  }
  async exchange(operation: Ma2Operation, target: number, expected = '', desired = '', signal?: AbortSignal, progress?: Ma2TransferProgress): Promise<{ response: string; requestId: string }> {
    signal?.throwIfAborted();
    if (this.queuedExchanges >= 32) throw new Error('控台操作过多，请等待当前操作完成');
    const epoch = this.exchangeEpoch;
    this.queuedExchanges += 1;
    const result = this.exchangeTail.then(async () => {
      if (epoch !== this.exchangeEpoch) throw new Error('前一项控台操作未完成，待处理操作已取消');
      try { return await this.performExchange(operation, target, expected, desired, signal, progress); }
      catch (error) { this.exchangeEpoch += 1; throw error; }
    }).finally(() => { this.queuedExchanges -= 1; });
    // Serialize the entire transaction, including all chunks and response release.
    // Scheduling consumes rejection only internally; callers retain the original error.
    this.exchangeTail = result.then(() => undefined, () => undefined);
    return result;
  }
  private async performExchange(operation: Ma2Operation, target: number, expected: string, desired: string, signal?: AbortSignal, progress?: Ma2TransferProgress): Promise<{ response: string; requestId: string }> {
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
    if (assigning && this.isPlaying()) throw new Error('播放期间不能创建 MA2 关联');
    if (operation === 'SEQUENCE' && (!['', 'keep'].includes(expected) || desired)) throw new Error('序列读取请求格式无效');
    if (operation === 'SEQCUES' && (!/^\d+\.\d{3}(?:,\d+\.\d{3})*$/.test(expected) || expected.length > 65536 || desired)) throw new Error('序列 Cue 读取范围无效');
    if (operation === 'TCRANGES' && (target !== 1 || expected || desired)) throw new Error('时间码范围读取请求格式无效');
    if (operation === 'DISCARD' && (!/^tblink_(?:backup|label|library)_[a-f0-9]{32}(?:,tblink_(?:backup|label|library)_[a-f0-9]{32})*$/.test(expected) || expected.length > 4096 || desired)) throw new Error('控台备份清理列表无效');
    if (operation === 'EXECUTOR' && (!/^[1-9]\d*$/.test(expected) || Number(expected) > 99999 || desired !== '')) throw new Error('执行器编号无效');
    const requestedSequences = operation === 'SCOPE' ? expected.split(',').map(Number) : [];
    if (operation === 'SCOPE' && (!/^[1-9]\d*(?:,[1-9]\d*)*$/.test(expected) || requestedSequences.some((number) => !Number.isInteger(number) || number > 99999) || new Set(requestedSequences).size !== requestedSequences.length)) throw new Error('额外序列读取范围无效');
    if (writing) {
      if (this.isPlaying()) throw new Error('播放期间不能写入 MA2 工程');
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
        else if (operation !== 'PING') {
          if (operation === 'SNAPSHOT' || operation === 'SCOPE') validateMa2TimecodeSnapshot(result, requestedSequences);
          else validateMa2TimecodeWrite(result);
          const report = inspectMa2TimecodeXml(result);
          if (report.timecodes.length !== 1 || report.timecodes[0]?.index !== target - 1) throw new Error('MA2 回读对象与绑定 Timecode 不一致，同步未确认');
        }
        if (writing && !sameMa2XmlObjects(desired, result)) throw new Error('MA2 写入后的回读与预期不一致；同步未完成，备份已保留。请重新读取控台检查引用及事件');
        return { response: result, requestId: id };
      };
      if (typeof this.dataDirectory !== 'string') {
        return validate(await this.dataDirectory.exchange(id, operation, target, body, () => {
          if ((writing || assigning) && this.isPlaying()) throw new Error('播放已开始，未发送 MA2 写入请求');
          sent = true;
        }, signal, progress));
      }
      const directory = join(this.dataDirectory, 'temp');
      for (const name of ['temp', 'plugins', 'importexport']) {
        if (!(await stat(join(this.dataDirectory, name))).isDirectory()) throw new Error('MA2 数据目录不完整');
      }
      const temporary = join(directory, `tblink_request_${id}.tmp`);
      signal?.throwIfAborted();
      await writeFile(temporary, `${id}\n${operation}\n${target}\n${Buffer.byteLength(body)}\n${body}`, 'utf8');
      if ((writing || assigning) && this.isPlaying()) throw new Error('播放已开始，未发送 MA2 写入请求');
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
      throw new Error('MA2 插件响应超时；同步未确认，不会自动重试。请检查插件和控台当前数据');
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
          if (!(backupError instanceof Error && 'code' in backupError && backupError.code === 'ENOENT')) message += `；备份核对失败：${backupError instanceof Error ? backupError.message : String(backupError)}`;
        }
      }
      throw new Ma2BridgeFailure(message, id, sent, { cause: error }, backupFile);
    }
  }
}
