import { ma2AdlerSums, ma2LzwDecoder, packMa2Bytes } from './ma2-transfer-codec';
import { createHash, randomBytes } from 'node:crypto';
import { ma2ResponseLine, type Ma2Telnet } from './ma2-telnet';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ma2LuaString, runMa2GuardedLua } from './ma2-lua-command';
import { readMa2ShowSource } from './ma2-show-probe';
import { setTimeout as delay } from 'node:timers/promises';

class BridgeAdmissionBusy extends Error {}

/** What the console has where the bundled bridge goes: it (`ready`), nothing (`missing`, also after the console loaded a
 * Show or restarted and the global is gone), an older bundled bridge (`old`), or something else (`foreign`). */
export type Ma2BridgeState = 'ready' | 'missing' | 'old' | 'foreign';

function bundled(source: string): { bytes: Buffer; digest: string } {
  const bytes = Buffer.from(source, 'utf8');
  if (!bytes.length || bytes.length > 256 * 1024) throw new Error('内置控台连接组件无效，请重新安装联动台');
  return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
}
function bootCall(connection: Pick<Ma2Telnet, 'command'>): (body: string) => Promise<string> {
  return async body => {
    const prefix = `TBLINK_BOOT_${randomBytes(16).toString('hex')}:`;
    return connection.command(`Lua "${body};gma.echo('${prefix}'..r)"`, (text) => ma2ResponseLine(text, prefix));
  };
}
const probe = (digest: string): string => `local r='missing';if type(TBLINK_NET)=='function' then if TBLINK_BRIDGE_SOURCE=='${digest}' and TBLINK_BRIDGE_READY==true and type(TBLINK_BRIDGE_GENERATION)=='string' and #TBLINK_BRIDGE_GENERATION>0 then r='ready' elseif type(TBLINK_BRIDGE_SOURCE)=='string' and #TBLINK_BRIDGE_SOURCE==64 and TBLINK_BRIDGE_SOURCE:gsub('[a-f0-9]','')=='' then r=(TBLINK_BRIDGE_READY==false and 'stopped:' or 'replace:')..TBLINK_BRIDGE_SOURCE else r='foreign' end end`;

/** Only looks (M5: logging in again during the show): one short command, the same check the install starts with; it never
 * installs, replaces or stops anything. */
export async function readMa2NetworkBridge(connection: Pick<Ma2Telnet, 'command'>, source: string): Promise<Ma2BridgeState> {
  const current = await bootCall(connection)(probe(bundled(source).digest));
  if (current === 'ready' || current === 'missing' || current === 'foreign') return current;
  if (/^(?:replace|stopped):[a-f0-9]{64}$/.test(current)) return 'old';
  throw new Error('控台连接组件状态无法识别');
}

/** Transfer only the application's bundled bridge. No project-supplied code or Show writes. */
export async function ensureMa2NetworkBridge(connection: Pick<Ma2Telnet, 'command'>, source: string, checkWait?: (waiting: boolean) => Promise<void>, localFiles = false): Promise<void> {
  const { bytes, digest } = bundled(source);
  const call = bootCall(connection);
  const inspect = () => call(probe(digest) + ";local b=TBLINK_BOOTSTRAP;if r~='ready' and r~='foreign' and type(b)=='table' and type(b.expires)=='number' and gma.gettime()<=b.expires then r='preparing' end");
  let current = await inspect();
  if (current === 'ready') return;
  const initial = checkWait && await readMa2ShowSource(connection);
  for (;;) {
    await checkWait?.(false);
    try { await install(connection, bytes, digest, current, localFiles); return; }
    catch (cause) { if (!(cause instanceof BridgeAdmissionBusy) || !checkWait || !initial) throw cause; }
    await checkWait(true);
    await delay(150);
    await checkWait(true);
    const observed = await readMa2ShowSource(connection);
    if (observed.show !== initial.show || observed.version !== initial.version) throw new Error('等待期间控台或 Show 已更换');
    current = await inspect();
    if (current === 'ready') { await checkWait(false); return; }
    if (current !== 'preparing' && observed.generation !== initial.generation) throw new Error('等待期间控台连接组件已更换');
  }
}

async function install(connection: Pick<Ma2Telnet, 'command'>, bytes: Buffer, digest: string, current: string, localFiles: boolean): Promise<void> {
  if (current === 'preparing') throw new BridgeAdmissionBusy('控台正在准备连接组件，本地可以继续编辑');
  const call = bootCall(connection);
  if (current === 'foreign') throw new Error('控台的连接接口被一个不认识的插件占用了，联动台没有覆盖它，请检查控台上的插件');
  const previousSource = /^(?:replace|stopped):([a-f0-9]{64})$/.exec(current)?.[1];
  const stopped = current.startsWith('stopped:');
  const owner = previousSource ? `TBLINK_BRIDGE_SOURCE=='${previousSource}'${stopped ? ' and TBLINK_BRIDGE_READY==false' : ''}` : "type(TBLINK_NET)~='function'";
  if (current !== 'missing' && !previousSource) throw new Error('控台连接组件状态无法识别');
  const id = randomBytes(16).toString('hex');
  const rpc = async (action: 'begin' | 'run' | 'read' | 'release', args = ''): Promise<string> => {
    const token = randomBytes(16).toString('hex');
    const prefix = `TBLINK_RPC_${token}:`;
    const invoke = `TBLINK_NET('${token}','${action}','${id}'${args})`;
    const script = action === 'begin'
      ? `if TBLINK_BRIDGE_SOURCE=='${previousSource}' and type(TBLINK_NET)=='function' then ${invoke} else gma.echo('${prefix}changed') end`
      : invoke;
    const value = await connection.command(`Lua "${script}"`, text => ma2ResponseLine(text, prefix));
    if (action === 'begin' && value === 'changed') throw new BridgeAdmissionBusy('控台连接组件已改变，正在重新核对');
    if (value.startsWith('ERR:')) {
      const reason = Buffer.from(value.slice(4), 'hex').toString('utf8');
      if (action === 'begin' && /(?:^|:\s*)Another network request is pending$/.test(reason)) throw new BridgeAdmissionBusy('控台正在处理上一项操作，本地可以继续编辑');
      throw new Error(`控台没有确认连接组件操作：${reason}`);
    }
    return value;
  };
  let acquired = false; let installed = false; let prepared = false;
  try {
    if (previousSource && !stopped) {
      // Acquire the old bridge's own transaction lock. A zero-size PING reads
      // only the version; it can never repeat a Show write or executor action.
      if (await rpc('begin', ",'PING',1,0") !== 'ACK') throw new Error('控台连接组件未确认升级占用');
      acquired = true;
      if (!/^DONE:\d+$/.test(await rpc('run'))) throw new Error('控台旧组件未确认只读核对');
    }
    // Install the chunk decoder once. Each later command can use most of the
    // native line for source bytes, while still echoing the exact stored bytes.
    const begin = await call([
      `local r='busy';if (${owner}) and (not TBLINK_BOOTSTRAP or gma.gettime()>TBLINK_BOOTSTRAP.expires) then `,
      `local b={id='${id}',parts={},size=0,expires=gma.gettime()+120};`,
      "local enc,dec={},{};for i=0,255 do local c=string.char(i);local h=string.format('%02x',i);enc[c]=h;dec[h]=c end;",
      "function b.part(i,at,h) if #b.parts+1~=i or b.size~=at then return 'invalid' end;",
      "local s=h:gsub('..',dec);b.parts[i]=s;b.size=at+#s;b.expires=gma.gettime()+120;return (s:gsub('.',enc)) end;",
      "TBLINK_BOOTSTRAP=b;r='ready' end"
    ].join(''));
    if (begin === 'busy') throw new BridgeAdmissionBusy('控台正在准备连接组件，本地可以继续编辑');
    if (begin !== 'ready') throw new Error('控台没有确认连接组件准备状态');
    prepared = true;
    if (!localFiles || !await stageLocalBridge(connection, id, bytes)) {
      await transferBridge(call, id, bytes, acquired ? () => rpc('read', ',0') : undefined);
    }
    if (previousSource) {
      const pause = await runMa2GuardedLua(connection, `local b=assert(TBLINK_BOOTSTRAP);assert(b.id=='${id}' and b.size==${bytes.length},'Incomplete bridge');assert(${owner},'Bridge owner changed');b.factory=assert(load(table.concat(b.parts),'tblink_bridge','t'));b.previous={net=TBLINK_NET,input=TBLINK_EXEC_INPUT,release=TBLINK_EXEC_RELEASE_ALL,source=TBLINK_BRIDGE_SOURCE,generation=TBLINK_BRIDGE_GENERATION,ready=TBLINK_BRIDGE_READY};if TBLINK_EXEC_RELEASE_ALL then TBLINK_EXEC_RELEASE_ALL() end;TBLINK_BRIDGE_GENERATION='upgrade_${id}';TBLINK_BRIDGE_READY=false;return 'paused'`, () => undefined);
      if (pause !== 'paused') throw new Error('控台旧组件未确认暂停，未替换');
      // Older bundled bridges have no release API; their key lease timer sees
      // the invalidated generation and releases held keys before the new bridge starts.
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    const ready = previousSource
      ? await runMa2GuardedLua(connection, `local b=assert(TBLINK_BOOTSTRAP);assert(b.id=='${id}' and TBLINK_NET==b.previous.net and TBLINK_BRIDGE_GENERATION=='upgrade_${id}','Bridge changed during upgrade');local ok,start=pcall(b.factory);local started=false;if ok and type(start)=='function' then started=pcall(start,'network') end;if started and TBLINK_BRIDGE_READY then TBLINK_BRIDGE_SOURCE='${digest}';TBLINK_BOOTSTRAP=nil;return 'ready' end;TBLINK_NET=b.previous.net;TBLINK_EXEC_INPUT=b.previous.input;TBLINK_EXEC_RELEASE_ALL=b.previous.release;TBLINK_BRIDGE_SOURCE=b.previous.source;TBLINK_BRIDGE_GENERATION=b.previous.generation;TBLINK_BRIDGE_READY=b.previous.ready;error('New bridge did not start; previous bridge retained')`, () => undefined)
      : await call(`local b=TBLINK_BOOTSTRAP;local r='invalid';if b and b.id=='${id}' and b.size==${bytes.length} and type(TBLINK_NET)~='function' then local f=load(table.concat(b.parts),'tblink_bridge','t');if f then local ok,start=pcall(f);if ok and type(start)=='function' then local started=pcall(start,'network');if started and TBLINK_BRIDGE_READY then TBLINK_BRIDGE_SOURCE='${digest}';TBLINK_BOOTSTRAP=nil;r='ready' end end end end`);
    if (ready !== 'ready') throw new Error('控台无法启动联动台的连接组件，请导出诊断包发给售后');
    installed = true;
  } catch (error) {
    const failures: string[] = [];
    if (prepared) {
      try {
        await runMa2GuardedLua(connection, `local b=TBLINK_BOOTSTRAP;if b and b.id=='${id}' then if b.previous and TBLINK_BRIDGE_GENERATION=='upgrade_${id}' then TBLINK_NET=b.previous.net;TBLINK_EXEC_INPUT=b.previous.input;TBLINK_EXEC_RELEASE_ALL=b.previous.release;TBLINK_BRIDGE_SOURCE=b.previous.source;TBLINK_BRIDGE_GENERATION=b.previous.generation;TBLINK_BRIDGE_READY=b.previous.ready end;TBLINK_BOOTSTRAP=nil end;return 'released'`, () => undefined);
      } catch (cleanup) { failures.push(String(cleanup)); }
    }
    if (acquired && !installed) {
      try { if (await rpc('release') !== 'ACK') throw new Error('旧组件占用未释放'); }
      catch (cleanup) { failures.push(String(cleanup)); }
    }
    if (!failures.length) throw error;
    throw new Error(`${error instanceof Error ? error.message : String(error)}；组件恢复情况需要确认：${failures.join('；')}`, { cause: error });
  }
}

/** Stage bytes in the existing bootstrap lease. The final load uses this in-memory string only
 * after the desk has echoed it in full. Closing or changing the source file cannot change it. */
async function stageLocalBridge(connection: Pick<Ma2Telnet, 'command'>, id: string, bytes: Buffer): Promise<boolean> {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-bridge-'));
  const input = join(directory, 'payload');
  const receipt = join(directory, 'receipt');
  try {
    await writeFile(input, bytes, { flag: 'wx' });
    await writeFile(receipt, '', { flag: 'wx' });
    const result = await runMa2GuardedLua(connection, [
      `local b=assert(TBLINK_BOOTSTRAP);assert(b.id=='${id}' and b.size==0);`,
      `local f=io.open(${ma2LuaString(input.replaceAll('\\', '/'))},'rb');if not f then return 'unavailable' end;`,
      `local s=f:read(${bytes.length + 1});f:close();assert(s and #s==${bytes.length},'Incomplete local source');`,
      `local r=io.open(${ma2LuaString(receipt.replaceAll('\\', '/'))},'wb');if not r then return 'unavailable' end;`,
      "assert(r:write(s));assert(r:close());b.parts={s};b.size=#s;return 'staged'"
    ].join(''), () => undefined);
    if (result === 'unavailable') return false;
    if (result !== 'staged' || !(await readFile(receipt)).equals(bytes)) throw new Error('控台读回的连接组件与软件不一致，没有启动');
    return true;
  } finally {
    await Promise.all([input, receipt].map(path => unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    })));
    await rmdir(directory);
  }
}

async function transferBridge(call: (body: string) => Promise<string>, id: string, bytes: Buffer, renew?: () => Promise<string>): Promise<void> {
  const payload = packMa2Bytes(bytes, 8192);
  if (payload !== bytes) {
    // Expand each acknowledged chunk separately, below MA's native command-line limit.
    // Independently check the decoded source before loading it, in addition to echoing every wire byte.
    const decoder = await call([
      `local b=assert(TBLINK_BOOTSTRAP);assert(b.id=='${id}');`,
      ma2LzwDecoder,
      "local part=b.part;function b.part(i,at,h)local echo=part(i,at,h);if echo~=h then return 'invalid' end;",
      "b.parts[i],b.a,b.z=expand(b.parts[i]);return echo end;local r='ready'"
    ].join(''));
    if (decoder !== 'ready') throw new Error('控台没有确认组件传输准备');
    // MA suspends long Lua byte loops at its instruction quota. Finish the same
    // bounded 350-byte chunk before waiting for the next console/network tick.
    const ready = await call(`local b=assert(TBLINK_BOOTSTRAP);assert(b.id=='${id}');local part=b.part;function b.part(i,at,h)local co=coroutine.create(function() return part(i,at,h) end);local ok,r;repeat ok,r=coroutine.resume(co);assert(ok,r) until coroutine.status(co)=='dead';return r end;local r='ready'`);
    if (ready !== 'ready') throw new Error('控台没有确认组件传输准备');
  }
  const chunkSize = 350; // The monitor echoes at most 700 hex characters, the same payload as a native Cue page line.
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    const chunk = payload.subarray(offset, offset + chunkSize);
    const index = offset / chunkSize + 1;
    const encoded = chunk.toString('hex');
    const reply = await call(`local h='${encoded}';local b=TBLINK_BOOTSTRAP;local r=b and b.id=='${id}' and b.part(${index},${offset},h) or 'invalid'`);
    if (reply !== encoded) throw new Error('控台连接组件没有传完，已停止连接');
    if (renew && index % 32 === 0 && !(await renew()).startsWith('DATA:')) throw new Error('控台连接组件升级占用已失效');
  }
  if (payload !== bytes) {
    const [a, b] = ma2AdlerSums(bytes);
    const complete = await call(`local b=TBLINK_BOOTSTRAP;local r='invalid';if b and b.id=='${id}' and b.size==${payload.length} and b.a==${a} and b.z==${b} and #table.concat(b.parts)==${bytes.length} then b.size=${bytes.length};r='ready' end`);
    if (complete !== 'ready') throw new Error('控台连接组件没有传完，已停止连接');
  }
}
