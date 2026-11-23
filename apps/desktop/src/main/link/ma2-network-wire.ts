import { randomBytes } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { MA2_MAX_SEQUENCE_BYTES } from '@tb/schema';
import { setTimeout as delay } from 'node:timers/promises';
import { open, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import { Ma2BridgeFailure, type Ma2Lane, type Ma2Operation, type Ma2TransferProgress, type Ma2Wire } from './ma2-onpc-bridge';
import { ma2ResponseLine, type Ma2Telnet } from './ma2-telnet';
import type { Ma2RequestJournal } from './ma2-request-journal';
import { MA2_BRIDGE_BUSY_BEFORE_REQUEST, MA2_BRIDGE_MISSING_BEFORE_REQUEST } from '@tb/core/link';
import { encodeMa2ReindexedDelta, encodeMa2SnapshotDelta } from './ma2-snapshot-delta';

class Ma2RpcRefusal extends Error {}
class Ma2BridgeMissing extends Error {}
class Ma2NotStarted extends Error {}
class Ma2LaneOccupied extends Ma2RpcRefusal {
  constructor(readonly source: string | undefined) { super(MA2_BRIDGE_BUSY_BEFORE_REQUEST); }
}

/** Only the loopback transport shares the onPC filesystem. A LAN address always uses the wire. */
export const ma2UsesLocalFiles = (host: string): boolean => host === '127.0.0.1' || host === '::1';

function responseChunks(text: string, prefix: string, offset: number, size: number, maxChunks = 32): string | null {
  const count = Math.min(maxChunks, Math.ceil((size - offset) / 256));
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
/** Recover the exact native bytes, including whitespace and a partial last line. */
function unpackSequence(encoded: Buffer, size: number): Buffer {
  const bytes = Buffer.allocUnsafe(size);
  const lines: Buffer[] = [];
  let at = 0, written = 0, dictionaryBytes = 0;
  while (at + 2 <= encoded.length) {
    const id = encoded.readUInt16BE(at); at += 2;
    let part: Buffer | undefined;
    if (id === 0 || id === 65535) {
      if (at + 2 > encoded.length) throw new Error('控台序列片段不完整');
      const length = encoded.readUInt16BE(at); at += 2;
      if (!length || at + length > encoded.length) throw new Error('控台序列片段不完整');
      part = encoded.subarray(at, at + length);
      at += length;
      if (id === 0) {
        dictionaryBytes += length;
        if (lines.length >= 65534 || length > 4096 || dictionaryBytes > 4194304) throw new Error('控台序列传输字典无效');
        lines.push(part);
      }
    } else part = lines[id - 1];
    if (!part || written + part.length > size) throw new Error('控台序列片段与声明的长度不一致');
    part.copy(bytes, written); written += part.length;
  }
  if (at !== encoded.length || written !== size) throw new Error('控台序列传输不完整');
  return bytes;
}
/** Digits, separators and letters dominate XML copy ranges. Escape every other byte
 * so native command syntax cannot interpret it; never split an escape across lines. */
function* uploadParts(data: Buffer, text: boolean): Generator<string> {
  if (!text) {
    for (let i = 0; i < data.length; i += 256) yield data.subarray(i, i + 256).toString('hex');
    return;
  }
  const encoded = data.toString('latin1').replace(/[^A-Za-z0-9 ,._:-]/g, ch => '~' + ch.charCodeAt(0).toString(16).padStart(2, '0'));
  for (let start = 0; start < encoded.length;) {
    let end = Math.min(start + 700, encoded.length);
    if (encoded[end - 1] === '~') end--;
    else if (encoded[end - 2] === '~') end -= 2;
    yield encoded.slice(start, end);
    start = end;
  }
}
function decodeResponse(bytes: Buffer, id: string, baseline?: ReadBaseline, syncBase?: ReadBaseline): { ok: boolean; value: string } {
  const text = bytes.toString('utf8');
  const snapshotCopy = text.startsWith(id + '\nSNAPCOPY\n');
  if (snapshotCopy || text.startsWith(id + '\nCOPY\n')) {
    const source = snapshotCopy ? syncBase : baseline;
    const copy = /^([a-f0-9]{32})\n(?:SNAPCOPY|COPY)\n([a-f0-9]{32})\n(\d+)\n(\d+)\n([\s\S]*)$/.exec(text);
    if (!source || !copy || copy[2] !== source.id) throw new Error('控台读回的数据对不上');
    const offset = Number(copy[3]), size = Number(copy[4]);
    const prefix = Buffer.from(copy[5]!);
    if (offset > source.content.length || prefix.length > (snapshotCopy ? 16384 : 2048) || size !== prefix.length + source.content.length - offset) throw new Error('控台读回的数据长度无效');
    const xml = Buffer.concat([prefix, source.content.subarray(offset)]).toString('utf8');
    return { ok: true, value: snapshotCopy ? 'SNAPSHOT\n' + xml : xml };
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
  private inlineDiscard = false;
  constructor(private readonly connection: Pick<Ma2Telnet, 'command'>, private readonly localFiles = false, private readonly journal?: Pick<Ma2RequestJournal, 'begin' | 'released'>, private readonly verifiedSnapshots = false, private readonly onMissing?: () => void) {}
  hasSnapshot(target: number, snapshot: string): boolean {
    return this.snapshot?.target === target && this.snapshot.content.equals(Buffer.from(snapshot));
  }
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
      if (!(error instanceof Ma2BridgeMissing) && !(error instanceof Ma2RpcRefusal && error.message.includes('Network request expired or mismatched'))) throw error;
    }
    this.journal?.released(id);
  }
  private async call(action: string, id: string, argumentsText = '', source = ''): Promise<string> {
    const token = randomBytes(16).toString('hex');
    // The console lost the bridge's globals (a Show was loaded or the console restarted).
    // A positive MISSING reply is different from a lost acknowledgement.
    const prefix = `TBLINK_RPC_${token}:`;
    // Keep even a full 256-byte chunk below the native console's command-line limit.
    // The human explanation belongs here, not as hundreds of hex bytes in every command.
    const line = `Lua "if TBLINK_NET then TBLINK_NET('${token}','${action}${source}','${id}'${argumentsText}) else gma.echo('${prefix}MISSING') end"`;
    const result = await this.connection.command(line, text => {
      const receipt = ma2ResponseLine(text, prefix);
      if (!receipt?.startsWith('INLINE:') || !['begin', 'run', 'step'].includes(action)) return receipt;
      const size = Number(receipt.slice(7));
      const limit = this.verifiedSnapshots && !this.localFiles ? 16384 : 8192;
      if (!Number.isInteger(size) || size < 1 || size >= limit) throw new Error('控台返回的数据长度无效');
      const chunks = responseChunks(text, 'TBLINK_INLINE_' + token + '_', 0, size, limit / 256);
      return chunks === null ? null : 'INLINE:' + chunks;
    });
    if (result === 'MISSING') {
      this.onMissing?.();
      throw new Ma2BridgeMissing('控台连接组件没在运行，本次操作已中断');
    }
    if (result.startsWith('ERR:')) {
      const encoded = result.slice(4);
      if (!/^(?:[a-f0-9]{2})+$/.test(encoded)) throw new Error('MA2 插件错误响应格式无效');
      const reason = Buffer.from(encoded, 'hex').toString('utf8');
      if (action === 'begin' || action === 'beginsync') {
        const occupied = /(?:^|:\s*)Another network request is pending((?::(?:[a-f0-9]{2})+){2})?$/.exec(reason);
        if (occupied) throw new Ma2LaneOccupied(occupied[1]);
        if (action === 'beginsync' && /(?:^|:\s*)Snapshot reference expired or mismatched$/.test(reason)) {
          this.snapshot = null;
          throw new Ma2NotStarted(MA2_BRIDGE_MISSING_BEFORE_REQUEST);
        }
        if (/(?:^|:\s*)Source changed before queued request$/.test(reason)) throw new Ma2NotStarted(MA2_BRIDGE_MISSING_BEFORE_REQUEST);
      }
      throw new Ma2RpcRefusal(`MA2：${reason}`);
    }
    return result;
  }
  /** Only an explicit negative admission is safe to repeat. The plugin checks the original Show and generation
   * in the same call that takes the slot. A lost reply, run or already admitted write never enters this loop. */
  private async reserve(action: string, id: string, args: string, gate: () => Promise<void>, signal?: AbortSignal): Promise<string> {
    let source = '', pause = 40;
    let firstRefusalAt: number | undefined;
    for (;;) {
      try { return await this.call(action, id, args, source); }
      catch (error) {
        if (!(error instanceof Ma2LaneOccupied) || !error.source || error.source.length + args.length > 850) throw error;
        if (source && error.source !== source) throw new Ma2NotStarted(MA2_BRIDGE_MISSING_BEFORE_REQUEST);
        firstRefusalAt ??= performance.now();
        source = error.source;
      }
      try { await delay(pause, undefined, { signal }); await gate(); signal?.throwIfAborted(); }
      catch (cause) {
        const reason: unknown = signal?.aborted ? signal.reason : cause;
        throw new Ma2NotStarted(reason instanceof Error ? reason.message : String(reason), { cause });
      }
      // Short reads release quickly during editing. Back off further when a
      // second client is doing a long export so its control connection gets time.
      pause = Math.min(performance.now() - firstRefusalAt < 1500 ? 100 : 250, pause * 2);
    }
  }
  /** After SEQGO acknowledges its Assign or SYNC acknowledges its Import,
   * finish the native readback even if an edit is cancelled during confirmation. */
  async exchange(id: string, operation: Ma2Operation, target: number, body: string, beforeSend: () => void, signal?: AbortSignal, progress?: Ma2TransferProgress, beforeStep?: (done: number, beforeImport?: boolean) => void | Promise<void>, lane: Ma2Lane = 'bg'): Promise<string> {
    let confirming = false;
    const checkCancellation = () => { if (!confirming) signal?.throwIfAborted(); };
    checkCancellation();
    if (!/^[a-f0-9]{32}$/.test(id) || !Number.isInteger(target) || target < 1 || target > 99999) throw new Error('无效的 MA2 网络请求');
    let data: Buffer = Buffer.from(body);
    if (data.length > 32 * 1024 * 1024) throw new Error('MA2 交换数据超过 32 MB');
    const newline = data.indexOf(10);
    const length = newline > 0 && /^\d+$/.test(data.subarray(0, newline).toString()) ? Number(data.subarray(0, newline).toString()) : -1;
    const reference = operation === 'SYNC' && this.snapshot?.target === target && length === this.snapshot.content.length && data.subarray(newline + 1, newline + 1 + length).equals(this.snapshot.content) ? this.snapshot.id : null;
    const syncBase = reference && this.verifiedSnapshots && !this.localFiles ? this.snapshot ?? undefined : undefined;
    if (reference) data = data.subarray(newline + 1 + length);
    const delta = reference && this.snapshot && !this.localFiles ? encodeMa2SnapshotDelta(this.snapshot.content, data) : null;
    const indexed = delta && this.snapshot && this.verifiedSnapshots ? encodeMa2ReindexedDelta(this.snapshot.content, data, delta) : null;
    const previousRead = operation === 'READ' && data.length === 0 && lane === 'bg' && this.lastRead?.target === target ? this.lastRead : undefined;
    const received = (bytes: Buffer): string => {
      const result = decodeResponse(bytes, id, previousRead, syncBase);
      if (!result.ok) throw new Error(`MA2：${result.value}`);
      if (operation === 'SNAPSHOT' || operation === 'SCOPE') this.snapshot = { id, target, content: Buffer.from(result.value) };
      if (operation === 'SYNC' && this.verifiedSnapshots && result.value.startsWith('SNAPSHOT\n')) {
        this.inlineDiscard = true;
        this.snapshot = { id, target, content: Buffer.from(result.value.slice('SNAPSHOT\n'.length)) };
      }
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
      const bundledQuery = this.verifiedSnapshots && lane === 'bg' && (operation === 'SEQCUES' && /^(?:names|values):/.test(body) || ['SNAPSHOT', 'SCOPE', 'FIRSTCUES', 'ASSIGNSEQ'].includes(operation) || operation === 'DISCARD' && this.inlineDiscard);
      const shortQuery = (bundledQuery || operation === 'LIST' || operation === 'LISTSEQ' || operation === 'TCRANGES' || operation === 'SEQGO' && lane === 'bg' && data.length > 0) && data.length <= 320;
      const readNow = operation === 'READ' && data.length === 0 && lane === 'bg' || shortQuery;
      if (readNow) { await beforeStep?.(0); checkCancellation(); beforeSend(); }
      this.journal?.begin(id); this.unreleased.add(id);
      const transport = this.localFiles ? ",'file'" : readNow || delta ? ',nil' : '';
      if (readNow) sent = true;
      const extension = delta ? `,nil,${delta.length}` : shortQuery ? `,nil,nil,'${data.toString('hex')}'` : previousRead ? `,'read',nil,nil,'${previousRead.id}'` : readNow ? ",'read'" : '';
      const dictionary = indexed ? `,nil,nil,${indexed.shift},${indexed.data.length}` : '';
      const wide = this.verifiedSnapshots && !this.localFiles;
      const queryLimit = wide && shortQuery ? ',nil,nil,nil,16384' : '';
      const proposed = indexed?.data ?? delta;
      const fewerParts = wide && proposed && proposed.length > 256 && [...uploadParts(proposed, true)].length < Math.ceil(proposed.length / 256);
      const chunkOffer = fewerParts ? (indexed ? '' : ',nil,nil,nil,nil') + ",'text'" : '';
      const begun = await this.reserve(reference ? 'beginsync' : 'begin', id, `,'${reference ?? operation}',${target},${data.length},'${lane}'${transport}${extension}${dictionary}${queryLimit}${chunkOffer}`, async () => {
        await beforeStep?.(0); checkCancellation();
        if (readNow) beforeSend();
      }, signal);
      // Older bridges ignore the final argument and ACK their reservation. Only
      // that ACK needs a subsequent run; a completed export is never replayed.
      const beganWithRead = readNow && /^(?:INLINE|DONE|FILE|STEP):/.test(begun);
      const upload = /^ACK:lanes:file:((?:[a-f0-9]{2})+)$/.exec(begun);
      const textUpload = Boolean(chunkOffer) && /^ACK:lanes:(indexed|delta):text$/.test(begun);
      const encodingAck = textUpload ? begun.slice(0, -5) : begun;
      if (indexed && encodingAck === 'ACK:lanes:indexed') data = indexed.data;
      else if (delta && encodingAck === 'ACK:lanes:delta') data = delta;
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
      } else if (!beganWithRead) {
        let part = 0;
        for (const encoded of uploadParts(data, textUpload)) {
          checkCancellation();
          if (await this.call(textUpload ? 'chunktext' : 'chunk', id, `,${++part},'${encoded}'`) !== 'ACK') throw new Error('MA2 未确认数据片段');
          progress?.();
        }
      }
      // The plugin does one console Export or Import per line and answers STEP:<steps done> until the
      // last, so stop and playback commands queued meanwhile go out between two steps. A plugin from
      // before steps ignores 'steps' and answers DONE at once, which is the same protocol.
      const inlineResult = ['READ', 'SEQCUES', 'LIST', 'LISTSEQ', 'TCRANGES', 'SNAPSHOT', 'SCOPE', 'SYNC', 'SEQGO', 'SETVALUES', 'FIRSTCUES', 'ASSIGNSEQ', 'DISCARD'].includes(operation);
      const confirmImport = this.verifiedSnapshots && operation === 'SYNC';
      let reply = begun;
      if (!beganWithRead) {
        checkCancellation(); await beforeStep?.(0); checkCancellation();
        if (!sent) { beforeSend(); sent = true; }
        const checked = this.verifiedSnapshots && ['SNAPSHOT', 'SCOPE', 'SYNC'].includes(operation);
        const run = operation === 'SEQUENCE' ? ",'steps','sequence'" : checked ? ",'steps','checked'" : inlineResult ? ",'steps','inline'" : ",'steps'";
        reply = await this.call('run', id, run + (confirmImport ? ",'confirm','snapshot'" + (wide ? ',16384' : '') + (syncBase ? ",'copy'" : '') : ''));
      }
      const stepReply = /^STEP:(\d+)(:before|:verify)?$/;
      let done = 0;
      for (let step = stepReply.exec(reply); step; step = stepReply.exec(reply)) {
        if (Number(step[1]) !== done + 1) throw new Error('控台分步执行的回答对不上');
        const beforeImport = step[2] === ':before';
        if ((beforeImport && !confirmImport) || (step[2] && operation !== 'SEQGO' && !confirmImport) || (confirming && step[2] !== ':verify')) throw new Error('控台写入确认阶段的回答对不上');
        confirming = step[2] === ':verify';
        done += 1;
        progress?.();
        // SEQGO may verify a very large backup in bounded chunks. Once its single
        // Assign has completed, finish only that readback; cancellation/show gates
        // still prevent all writes up to this point. Never replay the write.
        checkCancellation(); if (!confirming) await beforeStep?.(done, beforeImport); checkCancellation();
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
      const sequenceReceipt = operation === 'SEQUENCE' ? /^SEQDATA:(\d+)$/.exec(reply) : null;
      const sequenceFile = operation === 'SEQUENCE' ? /^SEQFILE:(\d+):((?:[a-f0-9]{2})+)$/.exec(reply) : null;
      const packed = operation === 'SEQUENCE' ? /^SEQPACK:(\d+):(\d+)$/.exec(reply) : null;
      const sequence = Boolean(sequenceReceipt || sequenceFile || packed);
      const local = sequenceFile ?? fileReceipt;
      const size = Number(packed?.[2] ?? sequenceReceipt?.[1] ?? local?.[1] ?? receipt?.[1]);
      if (!Number.isSafeInteger(size) || size < 1 || size > (sequence ? MA2_MAX_SEQUENCE_BYTES : 33554500)) throw new Error('MA2 响应长度无效');
      const nativeSize = packed ? Number(packed[1]) : size;
      if (packed && (!Number.isSafeInteger(nativeSize) || nativeSize <= size || nativeSize > MA2_MAX_SEQUENCE_BYTES)) throw new Error('控台序列声明的长度无效');
      let bytes: Buffer;
      if (local) {
        if (!this.localFiles) throw new Error('远程控台不能使用本机文件传输');
        checkCancellation();
        bytes = await this.readLocalResponse(Buffer.from(local[2]!, 'hex').toString('utf8'), id, size, sequence);
        checkCancellation();
        progress?.({ completed: size, total: size });
      } else {
        bytes = Buffer.allocUnsafe(size);
        for (let offset = 0; offset < size; offset += 8192) {
          checkCancellation();
          // A verified Sequence is immutable for this request. Let an operator's
          // foreground read run between batches, including after a long export.
          if (sequence) { await beforeStep?.(Math.max(done, 1)); checkCancellation(); }
          const chunk = await this.readBatch(id, offset, size, sequence || Boolean(receipt?.[2]));
          chunk.copy(bytes, offset);
          progress?.({ completed: offset + chunk.length, total: size });
        }
      }
      if (packed) bytes = unpackSequence(bytes, nativeSize);
      if (sequence && !isUtf8(bytes)) throw new Error('控台序列的文字编码无效');
      checkCancellation();
      releaseAttempted = true;
      if (await this.call('release', id, sequence ? ",'received'" : '') !== 'ACK') throw new Error('MA2 未确认传输结束');
      this.unreleased.delete(id);
      this.journal?.released(id);
      return sequence ? bytes.toString('utf8') : received(bytes);
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      if (!acquired && (error instanceof Ma2RpcRefusal || error instanceof Ma2BridgeMissing || error instanceof Ma2NotStarted)) {
        this.journal?.released(id); this.unreleased.delete(id);
        if (error instanceof Ma2LaneOccupied || error instanceof Ma2NotStarted) sent = false;
        if (error instanceof Ma2BridgeMissing) { sent = false; message = MA2_BRIDGE_MISSING_BEFORE_REQUEST; }
      }
      // Release only this transaction. Never execute it again or clear another client's request.
      if (acquired && !releaseAttempted) {
        try {
          await this.releaseAbandoned(id);
          this.unreleased.delete(id);
        }
        catch (cleanupError) { message += `；传输清理未确认：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`; }
      }
      const imported = confirming && operation === 'SYNC';
      throw new Ma2BridgeFailure(message, id, sent, { cause: error }, imported ? `tblink_backup_${id}.xml` : null, imported);
    }
  }
  private validateLocalPath(path: string, id: string, suffix = ''): void {
    if (!isAbsolute(path) || basename(path) !== `tblink_network_${id}${suffix}.bin` || basename(dirname(path)) !== 'temp') throw new Error('本机控台返回的数据文件位置无效');
  }
  private async readLocalResponse(path: string, id: string, size: number, sequence: boolean): Promise<Buffer> {
    if (sequence) {
      if (!isAbsolute(path) || basename(path) !== `tblink_library_${id}.xml` || basename(dirname(path)) !== 'importexport') throw new Error('本机控台返回的序列文件位置无效');
    } else this.validateLocalPath(path, id);
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
