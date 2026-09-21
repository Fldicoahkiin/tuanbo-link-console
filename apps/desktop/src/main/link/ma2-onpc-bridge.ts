import { randomUUID } from 'node:crypto';
import { ma2ObjectDirectorySchema } from '@tb/schema';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { inspectMa2SequenceXml, inspectMa2ExecutorXml, inspectMa2TimecodeXml, referencedMa2Sequences, sameMa2XmlObjects, validateMa2TimecodeSnapshot, validateMa2TimecodeWrite } from './ma2-timecode-xml';
export type Ma2Operation = 'PING' | 'LIST' | 'LISTSEQ' | 'SEQUENCE' | 'READ' | 'SNAPSHOT' | 'SCOPE' | 'APPLY' | 'SYNC' | 'CREATE' | 'EXECUTOR';
export type Ma2Wire = {
  exchange(id: string, operation: Ma2Operation, target: number, body: string, beforeSend: () => void): Promise<string>;
};
export class Ma2BridgeFailure extends Error {
  constructor(message: string, readonly requestId: string, readonly sent: boolean, options: ErrorOptions, readonly backupFile: string | null = null) { super(message, options); }
}

/** One request at a time; timeout is an uncertain outcome and is never retried. */
export class Ma2OnpcBridge {
  private busy = false;
  constructor(private readonly dataDirectory: string | Ma2Wire, private readonly isPlaying: () => boolean) {
    if (typeof dataDirectory === 'string' && !isAbsolute(dataDirectory)) throw new Error('MA2 数据目录必须是绝对路径');
  }
  async request(operation: Ma2Operation, target: number, expected = '', desired = ''): Promise<string> {
    return (await this.exchange(operation, target, expected, desired)).response;
  }
  async exchange(operation: Ma2Operation, target: number, expected = '', desired = ''): Promise<{ response: string; requestId: string }> {
    if (this.busy) throw new Error('MA2 正在交换数据');
    if (!Number.isInteger(target) || target < 1 || target > 99999) throw new Error('Timecode 编号无效');
    const writing = operation === 'APPLY' || operation === 'SYNC' || operation === 'CREATE';
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
    this.busy = true;
    const id = randomUUID().replaceAll('-', '');
    let sent = false;
    try {
      const body = writing ? `${Buffer.byteLength(expected)}\n${expected}${desired}` : operation === 'EXECUTOR' ? expected : operation === 'SCOPE' ? requestedSequences.sort((a, b) => a - b).join(',') : '';
      if (Buffer.byteLength(body) > 32 * 1024 * 1024) throw new Error('MA2 交换数据超过 32 MB');
      const validate = (result: string): { response: string; requestId: string } => {
        if (operation === 'LIST' || operation === 'LISTSEQ') ma2ObjectDirectorySchema.parse(JSON.parse(result));
        else if (operation === 'SEQUENCE') {
          const report = inspectMa2SequenceXml(result);
          if (report.sequences.length !== 1 || report.sequences[0]?.number !== target) throw new Error('Sequence 回读对象不一致');
        }
        else if (operation === 'EXECUTOR') inspectMa2ExecutorXml(result);
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
          if (writing && this.isPlaying()) throw new Error('播放已开始，未发送 MA2 写入请求');
          sent = true;
        }));
      }
      const directory = join(this.dataDirectory, 'temp');
      for (const name of ['temp', 'plugins', 'importexport']) {
        if (!(await stat(join(this.dataDirectory, name))).isDirectory()) throw new Error('MA2 数据目录不完整');
      }
      const temporary = join(directory, `tblink_request_${id}.tmp`);
      await writeFile(temporary, `${id}\n${operation}\n${target}\n${Buffer.byteLength(body)}\n${body}`, 'utf8');
      if (writing && this.isPlaying()) throw new Error('播放已开始，未发送 MA2 写入请求');
      await rename(temporary, join(directory, 'tblink_bridge_request.txt'));
      sent = true;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
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
    } finally { this.busy = false; }
  }
}
