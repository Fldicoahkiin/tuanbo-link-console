import { ma2AdlerSums, ma2LzwDecoder, packMa2Bytes } from './ma2-transfer-codec';
import { createHash, randomBytes } from 'node:crypto';
import { ma2ResponseLine, type Ma2Telnet } from './ma2-telnet';
import { runMa2GuardedLua } from './ma2-lua-command';

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
const probe = (digest: string): string => `local r='missing';if type(TBLINK_NET)=='function' then if TBLINK_BRIDGE_SOURCE=='${digest}' and TBLINK_BRIDGE_READY==true and type(TBLINK_BRIDGE_GENERATION)=='string' and #TBLINK_BRIDGE_GENERATION>0 then r='ready' elseif type(TBLINK_BRIDGE_SOURCE)=='string' and #TBLINK_BRIDGE_SOURCE==64 and TBLINK_BRIDGE_SOURCE:gsub('[a-f0-9]','')=='' then r='replace:'..TBLINK_BRIDGE_SOURCE else r='foreign' end end`;

/** Only looks (M5: logging in again during the show): one short command, the same check the install starts with; it never
 * installs, replaces or stops anything. */
export async function readMa2NetworkBridge(connection: Pick<Ma2Telnet, 'command'>, source: string): Promise<Ma2BridgeState> {
  const current = await bootCall(connection)(probe(bundled(source).digest));
  if (current === 'ready' || current === 'missing' || current === 'foreign') return current;
  if (/^replace:[a-f0-9]{64}$/.test(current)) return 'old';
  throw new Error('控台连接组件状态无法识别');
}

/** Transfer only the application's bundled bridge. No project-supplied code or Show writes. */
export async function ensureMa2NetworkBridge(connection: Pick<Ma2Telnet, 'command'>, source: string): Promise<void> {
  const { bytes, digest } = bundled(source);
  const call = bootCall(connection);
  const current = await call(probe(digest));
  if (current === 'ready') return;
  if (current === 'foreign') throw new Error('控台的连接接口被一个不认识的插件占用了，联动台没有覆盖它，请检查控台上的插件');
  const previousSource = /^replace:([a-f0-9]{64})$/.exec(current)?.[1];
  if (current !== 'missing' && !previousSource) throw new Error('控台连接组件状态无法识别');
  const id = randomBytes(16).toString('hex');
  const rpc = async (action: 'begin' | 'run' | 'read' | 'release', args = ''): Promise<string> => {
    const token = randomBytes(16).toString('hex');
    const prefix = `TBLINK_RPC_${token}:`;
    const value = await connection.command(`Lua "TBLINK_NET('${token}','${action}','${id}'${args})"`, text => ma2ResponseLine(text, prefix));
    if (value.startsWith('ERR:')) throw new Error(`控台连接组件正忙：${Buffer.from(value.slice(4), 'hex').toString('utf8')}；本地可以继续编辑`);
    return value;
  };
  let acquired = false; let installed = false; let prepared = false;
  try {
    if (previousSource) {
      // Acquire the old bridge's own transaction lock. A zero-size PING reads
      // only the version; it can never repeat a Show write or executor action.
      if (await rpc('begin', ",'PING',1,0") !== 'ACK') throw new Error('控台连接组件未确认升级占用');
      acquired = true;
      if (!/^DONE:\d+$/.test(await rpc('run'))) throw new Error('控台旧组件未确认只读核对');
    }
    // Install the chunk decoder once. Each later command can use most of the
    // native line for source bytes, while still echoing the exact stored bytes.
    const begin = await call([
      "local r='busy';if not TBLINK_BOOTSTRAP or gma.gettime()>TBLINK_BOOTSTRAP.expires then ",
      `local b={id='${id}',parts={},size=0,expires=gma.gettime()+120};`,
      "local enc,dec={},{};for i=0,255 do local c=string.char(i);local h=string.format('%02x',i);enc[c]=h;dec[h]=c end;",
      "function b.part(i,at,h) if #b.parts+1~=i or b.size~=at then return 'invalid' end;",
      "local s=h:gsub('..',dec);b.parts[i]=s;b.size=at+#s;b.expires=gma.gettime()+120;return (s:gsub('.',enc)) end;",
      "TBLINK_BOOTSTRAP=b;r='ready' end"
    ].join(''));
    if (begin !== 'ready') throw new Error('控台正在准备连接组件，请稍后连接');
    prepared = true;
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
      if (acquired && index % 32 === 0 && !(await rpc('read', ',0')).startsWith('DATA:')) throw new Error('控台连接组件升级占用已失效');
    }
    if (payload !== bytes) {
      const [a, b] = ma2AdlerSums(bytes);
      const complete = await call(`local b=TBLINK_BOOTSTRAP;local r='invalid';if b and b.id=='${id}' and b.size==${payload.length} and b.a==${a} and b.z==${b} and #table.concat(b.parts)==${bytes.length} then b.size=${bytes.length};r='ready' end`);
      if (complete !== 'ready') throw new Error('控台连接组件没有传完，已停止连接');
    }
    if (previousSource) {
      const pause = await runMa2GuardedLua(connection, `local b=assert(TBLINK_BOOTSTRAP);assert(b.id=='${id}' and b.size==${bytes.length},'Incomplete bridge');assert(TBLINK_BRIDGE_SOURCE=='${previousSource}','Bridge owner changed');b.factory=assert(load(table.concat(b.parts),'tblink_bridge','t'));b.previous={net=TBLINK_NET,input=TBLINK_EXEC_INPUT,release=TBLINK_EXEC_RELEASE_ALL,source=TBLINK_BRIDGE_SOURCE,generation=TBLINK_BRIDGE_GENERATION,ready=TBLINK_BRIDGE_READY};if TBLINK_EXEC_RELEASE_ALL then TBLINK_EXEC_RELEASE_ALL() end;TBLINK_BRIDGE_GENERATION='upgrade_${id}';TBLINK_BRIDGE_READY=false;return 'paused'`, () => undefined);
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
    throw new Error(`${error instanceof Error ? error.message : String(error)}${failures.length ? `；组件恢复情况需要确认：${failures.join('；')}` : ''}`, { cause: error });
  }
}
