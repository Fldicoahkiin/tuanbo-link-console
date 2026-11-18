import { randomBytes } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import { Ma2BridgeFailure, type Ma2Lane, type Ma2Operation, type Ma2TransferProgress, type Ma2Wire } from './ma2-onpc-bridge';
import { ma2ResponseLine, type Ma2Telnet } from './ma2-telnet';
import type { Ma2RequestJournal } from './ma2-request-journal';
import { encodeMa2SnapshotDelta } from './ma2-snapshot-delta';

class Ma2RpcRefusal extends Error {}

function responseChunks(text: string, prefix: string, offset: number, size: number): string | null {
  const count = Math.min(32, Math.ceil((size - offset) / 256));
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const result = ma2ResponseLine(text, prefix + i.toString(16).padStart(4, '0') + ':');
    if (result === null) return null;
    const encoded = /^DATA:((?:[a-f0-9]{2})+)$/.exec(result)?.[1];
    if (!encoded || encoded.length !== Math.min(256, size - offset - i * 256) * 2) throw new Error('控台读回的数据缺失或无效');
    parts.push(encoded);
  }
  return parts.join('');
}

type ReadBaseline = { id: string; target: number; content: Buffer };
function decodeResponse(bytes: Buffer, id: string, baseline?: ReadBaseline): { ok: boolean; value: string } {
  const text = bytes.toString('utf8');
  if (baseline && text.startsWith(id + '\nCOPY\n')) {
    const copy = /^([a-f0-9]{32})\nCOPY\n([a-f0-9]{32})\n(\d+)\n(\d+)\n([\s\S]*)$/.exec(text);
    if (!copy || copy[2] !== baseline.id) throw new Error('控台读回的数据对不上');
    const offset = Number(copy[3]), size = Number(copy[4]);
    const prefix = Buffer.from(copy[5]!);
    if (offset > baseline.content.length || prefix.length > 2048 || size !== prefix.length + baseline.content.length - offset) throw new Error('控台读回的数据长度无效');
    return { ok: true, value: Buffer.concat([prefix, baseline.content.subarray(offset)]).toString('utf8') };
  }
  const match = /^([a-f0-9]{32})\n(OK|ERROR)\n(\d+)\n([\s\S]*)$/.exec(text);
  if (!match || match[1] !== id || Buffer.byteLength(match[4] ?? '') !== Number(match[3])) throw new Error('控台读回的数据对不上');
  return { ok: match[2] === 'OK', value: match[4] ?? '' };
}

/** Chunked RPC over an authenticated command channel; uncertain writes are never replayed. */
export class Ma2NetworkWire implements Ma2Wire {
  private snapshot: ReadBaseline | null = null;
  private lastRead: ReadBaseline | undefined;
  private readonly unreleased = new Set<string>();
  private twoLanes: boolean | null = null;
  constructor(private readonly connection: Pick<Ma2Telnet, 'command'>, private readonly localFiles = false, private readonly journal?: Pick<Ma2RequestJournal, 'begin' | 'released'>) {}
  /** The requests this wire began on the console and has not released, one per lane; the plugin keeps each for 120 s. */
  get unreleasedRequests(): string[] { return [...this.unreleased]; }
  /** Whether the running plugin keeps a foreground lane beside the background one: learned from the first 'begin'
   * (a plugin from before lanes ignores the lane and answers a plain ACK). Null until then. */
  get lanes(): boolean | null { return this.twoLanes; }
  /** Releases only the given request id; the plugin refuses any other client's transaction. */
  async releaseAbandoned(id: string): Promise<void> {
    try { if (await this.call('release', id) !== 'ACK') throw new Error('控台未确认释放'); }
    catch (error) {
      // An expired or absent ID no longer owns a slot. Never release another ID instead.
      if (!(error instanceof Ma2RpcRefusal && error.message.includes('Network request expired or mismatched'))) throw error;
    }
    this.journal?.released(id);
  }
  private async call(action: string, id: string, argumentsText = ''): Promise<string> {
    const token = randomBytes(16).toString('hex');
    // The console lost the bridge's globals (a Show was loaded or the console restarted).
    // The bridge is installed at login only, so the way back is to connect again.
    const prefix = `TBLINK_RPC_${token}:`;
    // Keep even a full 256-byte chunk below the native console's command-line limit.
    // The human explanation belongs here, not as hundreds of hex bytes in every command.
    const line = `Lua "if TBLINK_NET then TBLINK_NET('${token}','${action}','${id}'${argumentsText}) else gma.echo('${prefix}MISSING') end"`;
    const result = await this.connection.command(line, text => {
      const receipt = ma2ResponseLine(text, prefix);
      if (!receipt?.startsWith('INLINE:') || !['begin', 'run', 'step'].includes(action)) return receipt;
      const size = Number(receipt.slice(7));
      if (!Number.isInteger(size) || size < 1 || size >= 8192) throw new Error('控台返回的数据长度无效');
      const chunks = responseChunks(text, 'TBLINK_INLINE_' + token + '_', 0, size);
      return chunks === null ? null : 'INLINE:' + chunks;
    });
    if (result === 'MISSING') throw new Error('控台连接组件没在运行，可能是控台换过 Show 或重启过。没在播放时，到设置里把控台断开再连接一次，联动台会把它装回去');
    if (result.startsWith('ERR:')) {
      const encoded = result.slice(4);
      if (!/^(?:[a-f0-9]{2})+$/.test(encoded)) throw new Error('MA2 插件错误响应格式无效');
      throw new Ma2RpcRefusal(`MA2：${Buffer.from(encoded, 'hex').toString('utf8')}`);
    }
    return result;
  }
  /** `beforeStep` runs before each interruptible step, the first included, with the steps done. Once SEQGO
   * acknowledges its write, only readback remains; finish it even if cancelled, then release the request. */
  async exchange(id: string, operation: Ma2Operation, target: number, body: string, beforeSend: () => void, signal?: AbortSignal, progress?: Ma2TransferProgress, beforeStep?: (done: number) => void | Promise<void>, lane: Ma2Lane = 'bg'): Promise<string> {
    let confirming = false;
    const checkCancellation = () => { if (!confirming) signal?.throwIfAborted(); };
    checkCancellation();
    if (!/^[a-f0-9]{32}$/.test(id) || !Number.isInteger(target) || target < 1 || target > 99999) throw new Error('无效的 MA2 网络请求');
    let data: Buffer = Buffer.from(body);
    if (data.length > 32 * 1024 * 1024) throw new Error('MA2 交换数据超过 32 MB');
    const newline = data.indexOf(10);
    const length = newline > 0 && /^\d+$/.test(data.subarray(0, newline).toString()) ? Number(data.subarray(0, newline).toString()) : -1;
    const reference = operation === 'SYNC' && this.snapshot?.target === target && length === this.snapshot.content.length && data.subarray(newline + 1, newline + 1 + length).equals(this.snapshot.content) ? this.snapshot.id : null;
    if (reference) data = data.subarray(newline + 1 + length);
    const delta = reference && this.snapshot && !this.localFiles ? encodeMa2SnapshotDelta(this.snapshot.content, data) : null;
    const previousRead = operation === 'READ' && data.length === 0 && lane === 'bg' && this.lastRead?.target === target ? this.lastRead : undefined;
    const received = (bytes: Buffer): string => {
      const result = decodeResponse(bytes, id, previousRead);
      if (!result.ok) throw new Error(`MA2：${result.value}`);
      if (operation === 'SNAPSHOT' || operation === 'SCOPE') this.snapshot = { id, target, content: Buffer.from(result.value) };
      if (operation === 'READ' && lane === 'bg') {
        this.lastRead = Buffer.byteLength(result.value) <= 524288 ? { id, target, content: Buffer.from(result.value) } : undefined;
      }
      return result.value;
    };
    let sent = false;
    let acquired = false;
    let releaseAttempted = false;
    try {
      if (reference && lane !== 'bg') throw new Error('无效的 MA2 网络请求');
      // SEQGO's first step only exports the sequence. Its native write remains a
      // separate, gated step after the second export and comparison.
      const shortQuery = (operation === 'LIST' || operation === 'LISTSEQ' || operation === 'TCRANGES' || operation === 'SEQGO' && lane === 'bg' && data.length > 0) && data.length <= 320;
      const readNow = operation === 'READ' && data.length === 0 && lane === 'bg' || shortQuery;
      if (readNow) { await beforeStep?.(0); checkCancellation(); beforeSend(); }
      this.journal?.begin(id); this.unreleased.add(id);
      const transport = this.localFiles ? ",'file'" : readNow || delta ? ',nil' : '';
      if (readNow) sent = true;
      const extension = delta ? `,nil,${delta.length}` : shortQuery ? `,nil,nil,'${data.toString('hex')}'` : previousRead ? `,'read',nil,nil,'${previousRead.id}'` : readNow ? ",'read'" : '';
      const begun = await this.call(reference ? 'beginsync' : 'begin', id, `,'${reference ?? operation}',${target},${data.length},'${lane}'${transport}${extension}`);
      // Older bridges ignore the final argument and ACK their reservation. Only
      // that ACK needs a subsequent run; a completed export is never replayed.
      const beganWithRead = readNow && /^(?:INLINE|DONE|FILE|STEP):/.test(begun);
      const upload = /^ACK:lanes:file:((?:[a-f0-9]{2})+)$/.exec(begun);
      if (delta && begun === 'ACK:lanes:delta') data = delta;
      else if (!beganWithRead && begun !== 'ACK' && begun !== 'ACK:lanes' && !upload) throw new Error('MA2 未确认传输开始');
      acquired = true; this.unreleased.add(id);
      // A plugin from before lanes holds one request for both: this one is it, whatever lane was asked for.
      this.twoLanes = beganWithRead || begun.startsWith('ACK:lanes');
      if (upload) {
        if (!this.localFiles) throw new Error('远程控台不能使用本机文件传输');
        const path = Buffer.from(upload[1]!, 'hex').toString('utf8');
        this.validateLocalPath(path, id, '.input');
        checkCancellation();
        await writeFile(path, data, { flag: 'wx', signal });
        progress?.();
      } else for (let offset = 0; !beganWithRead && offset < data.length; offset += 256) {
        checkCancellation();
        if (await this.call('chunk', id, `,${offset / 256 + 1},'${data.subarray(offset, offset + 256).toString('hex')}'`) !== 'ACK') throw new Error('MA2 未确认数据片段');
        progress?.();
      }
      // The plugin does one console Export or Import per line and answers STEP:<steps done> until the
      // last, so stop and playback commands queued meanwhile go out between two steps. A plugin from
      // before steps ignores 'steps' and answers DONE at once, which is the same protocol.
      const inlineResult = ['READ', 'LIST', 'LISTSEQ', 'TCRANGES', 'SNAPSHOT', 'SCOPE', 'SYNC', 'SEQGO'].includes(operation);
      let reply = begun;
      if (!beganWithRead) {
        checkCancellation(); await beforeStep?.(0); checkCancellation();
        if (!sent) { beforeSend(); sent = true; }
        reply = await this.call('run', id, inlineResult ? ",'steps','inline'" : ",'steps'");
      }
      for (let done = 0, step = /^STEP:(\d+)(:verify)?$/.exec(reply); step; step = /^STEP:(\d+)(:verify)?$/.exec(reply)) {
        if (Number(step[1]) !== done + 1) throw new Error('控台分步执行的回答对不上');
        if ((step[2] && operation !== 'SEQGO') || (confirming && !step[2])) throw new Error('控台写入确认阶段的回答对不上');
        confirming = Boolean(step[2]);
        done += 1;
        progress?.();
        // SEQGO may verify a very large backup in bounded chunks. Once its single
        // Assign has completed, finish only that readback; cancellation/show gates
        // still prevent all writes up to this point. Never replay the write.
        checkCancellation(); if (!confirming) await beforeStep?.(done); checkCancellation();
        reply = await this.call('step', id);
      }
      if (inlineResult && reply.startsWith('INLINE:')) {
        // A complete response, including the verified readback of a SYNC, released its lane.
        releaseAttempted = true;
        this.unreleased.delete(id); this.journal?.released(id);
        checkCancellation();
        return received(Buffer.from(reply.slice(7), 'hex'));
      }
      const receipt = /^DONE:(\d+)(:batch)?$/.exec(reply);
      const fileReceipt = /^FILE:(\d+):((?:[a-f0-9]{2})+)$/.exec(reply);
      const size = Number(receipt?.[1] ?? fileReceipt?.[1]);
      if (!Number.isInteger(size) || size < 1 || size > 33554500) throw new Error('MA2 响应长度无效');
      const chunks: Buffer[] = [];
      if (fileReceipt) {
        if (!this.localFiles) throw new Error('远程控台不能使用本机文件传输');
        checkCancellation();
        chunks.push(await this.readLocalResponse(Buffer.from(fileReceipt[2]!, 'hex').toString('utf8'), id, size));
        checkCancellation();
        progress?.({ completed: size, total: size });
      } else for (let offset = 0; offset < size; offset += 8192) {
        checkCancellation();
        chunks.push(await this.readBatch(id, offset, size, Boolean(receipt?.[2])));
        progress?.({ completed: Math.min(offset + 8192, size), total: size });
      }
      releaseAttempted = true;
      if (await this.call('release', id) !== 'ACK') throw new Error('MA2 未确认传输结束');
      this.unreleased.delete(id);
      this.journal?.released(id);
      return received(Buffer.concat(chunks));
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      if (!acquired && error instanceof Ma2RpcRefusal) { this.journal?.released(id); this.unreleased.delete(id); }
      // Release only this transaction. Never execute it again or clear another client's request.
      if (acquired && !releaseAttempted) {
        try {
          await this.releaseAbandoned(id);
          this.unreleased.delete(id);
        }
        catch (cleanupError) { message += `；传输清理未确认：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`; }
      }
      throw new Ma2BridgeFailure(message, id, sent, { cause: error });
    }
  }
  private validateLocalPath(path: string, id: string, suffix = ''): void {
    if (!isAbsolute(path) || basename(path) !== `tblink_network_${id}${suffix}.bin` || basename(dirname(path)) !== 'temp') throw new Error('本机控台返回的数据文件位置无效');
  }
  private async readLocalResponse(path: string, id: string, size: number): Promise<Buffer> {
    this.validateLocalPath(path, id);
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== size) throw new Error('本机控台返回的数据文件长度不一致');
      // Bound allocation even if another process changes the file after stat.
      const data = Buffer.alloc(size + 1);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== size) throw new Error('本机控台返回的数据文件不完整');
      return data.subarray(0, size);
    } finally { await file.close(); }
  }
  private async readBatch(id: string, offset: number, size: number, nativeBatch: boolean): Promise<Buffer> {
    const token = randomBytes(14).toString('hex');
    const count = Math.min(32, Math.ceil((size - offset) / 256));
    const line = nativeBatch
      ? `Lua "TBLINK_NET('${token}0000','readbatch','${id}',${offset},${count})"`
      : `Lua "for i=0,${count - 1} do TBLINK_NET('${token}'..string.format('%04x',i),'read','${id}',${offset}+i*256) end"`;
    const value = await this.connection.command(line, text => responseChunks(text, 'TBLINK_RPC_' + token, offset, size));
    return Buffer.from(value, 'hex');
  }
}
