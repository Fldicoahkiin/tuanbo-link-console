import { createHash, randomBytes } from 'node:crypto';
import { ma2ResponseLine, type Ma2Telnet } from './ma2-telnet';

/** Transfer only the application's bundled bridge. No project-supplied code or Show writes. */
export async function ensureMa2NetworkBridge(connection: Pick<Ma2Telnet, 'command'>, source: string): Promise<void> {
  const bytes = Buffer.from(source, 'utf8');
  if (!bytes.length || bytes.length > 256 * 1024) throw new Error('内置控台连接组件无效，请重新安装联动台');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const call = async (body: string): Promise<string> => {
    const prefix = `TBLINK_BOOT_${randomBytes(16).toString('hex')}:`;
    return connection.command(`Lua "${body};gma.echo('${prefix}'..r)"`, (text) => ma2ResponseLine(text, prefix));
  };
  const current = await call(`local r='missing';if type(TBLINK_NET)=='function' then r=(TBLINK_BRIDGE_SOURCE=='${digest}' and TBLINK_BRIDGE_READY==true) and 'ready' or 'existing' end`);
  if (current === 'ready') return;
  if (current === 'existing') throw new Error('控台正在使用另一版联动组件，请停止同步并重新启动控台后连接');
  if (current !== 'missing') throw new Error('控台连接组件状态无法识别');
  const id = randomBytes(16).toString('hex');
  const begin = await call(`local r='busy';if not TBLINK_BOOTSTRAP or gma.gettime()>TBLINK_BOOTSTRAP.expires then TBLINK_BOOTSTRAP={id='${id}',parts={},size=0,expires=gma.gettime()+120};r='ready' end`);
  if (begin !== 'ready') throw new Error('控台正在准备连接组件，请稍后连接');
  for (let offset = 0; offset < bytes.length; offset += 128) {
    const chunk = bytes.subarray(offset, offset + 128);
    const index = offset / 128 + 1;
    const encoded = chunk.toString('hex');
    const reply = await call(`local b=TBLINK_BOOTSTRAP;local r='invalid';if b and b.id=='${id}' and #b.parts==${index - 1} and b.size==${offset} then local h='${encoded}';local s=h:gsub('..',function(x)return string.char(tonumber(x,16))end);b.parts[${index}]=s;b.size=b.size+#s;b.expires=gma.gettime()+120;r=(s:gsub('.',function(x)return string.format('%02x',string.byte(x))end)) end`);
    if (reply !== encoded) throw new Error('控台连接组件传输不完整，已停止连接');
  }
  const ready = await call(`local b=TBLINK_BOOTSTRAP;local r='invalid';if b and b.id=='${id}' and b.size==${bytes.length} and type(TBLINK_NET)~='function' then local f=load(table.concat(b.parts),'tblink_bridge','t');if f then local ok,start=pcall(f);if ok and type(start)=='function' then local started=pcall(start,'network');if started and TBLINK_BRIDGE_READY then TBLINK_BRIDGE_SOURCE='${digest}';TBLINK_BOOTSTRAP=nil;r='ready' end end end end`);
  if (ready !== 'ready') throw new Error('控台无法启动内置连接组件，请导出诊断信息');
}
