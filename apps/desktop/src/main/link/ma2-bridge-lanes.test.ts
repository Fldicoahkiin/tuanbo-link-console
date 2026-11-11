import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isShowWait, type ShowState } from '@tb/core/link';
import { Ma2LuaConsole, singleRunBridgeSource } from './fixtures/ma2-lua-console';
import { idleShow, runningShow, showReader } from './fixtures/show-gates';
import { Ma2NetworkWire } from './ma2-network-wire';
import { Ma2BridgeFailure, ma2Lane, Ma2OnpcBridge, ma2WriteStep, type Ma2Operation } from './ma2-onpc-bridge';
import { ma2ResponseLine } from './ma2-telnet';

// M4 (03 §4.2.1): the plugin keeps two requests, one per lane. A short read an operator waits for (a page, the
// directory, one executor) runs whole between two steps of a sync, instead of waiting for the whole sync. The real
// tools/ma2/tblink_bridge.lua runs here in Lua 5.3 against the fake console, behind the real wire and bridge.

const timecode = readFileSync(new URL('./fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url), 'utf8');
const sequence = readFileSync(new URL('./fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url), 'utf8');
// Timecode 9902 fires Sequence 9901; the edit moves its second Cue and adds one from Sequence 9903.
const desired = timecode.replace('time="45"', 'time="60"').replace('</SubTrack>', '<Event index="2" time="90" command="Goto" pressed="true" step="3"><Cue name="Cue 1.25"><No>1</No><No>9903</No><No>1</No></Cue></Event></SubTrack>');
const pageXml = '<MA xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://schemas.malighting.de/grandma2/xml/MA" major_vers="3" minor_vers="3" stream_vers="4"><Page index="6"><Exec xsi:nil="true" /><Exec offset_from_first="0"><Assignment name="A"><No>25</No><No>1</No><No>9901</No></Assignment></Exec><Exec offset_from_first="0"><Assignment name="B"><No>25</No><No>1</No><No>9903</No></Assignment></Exec></Page></MA>';
const hex = (text: string): string => Buffer.from(text).toString('hex');
const stepLine = /','(?:run|step)','/;
/** Action and request id of a plugin line, or null for any other console line. */
const rpcOf = (line: string): { action: string; id: string } | null => {
  const match = /TBLINK_NET\('[a-f0-9]+','(\w+)','([a-f0-9]{32})'/.exec(line);
  return match ? { action: match[1]!, id: match[2]! } : null;
};

function rig(source?: string) {
  const ma2 = new Ma2LuaConsole(source);
  ma2.set('Timecode 9902', { xml: timecode, name: 'TBLINK_FRACTIONAL_TIMECODE' });
  ma2.set('Sequence 9901', { xml: sequence, name: 'TBLINK_CUE_REFERENCE_ACCEPTANCE', label: 'A', cues: [{ number: '1', label: '一' }, { number: '1.25', label: '二' }] });
  ma2.set('Sequence 9903', { xml: sequence.replace('<Sequ index="9900"', '<Sequ index="9902"'), name: 'TBLINK_CUE_REFERENCE_ACCEPTANCE', label: 'B', cues: [{ number: '1', label: '一' }] });
  ma2.set('Page 7', { label: '第七页' });
  ma2.lua(`FAKE.objects['Page 7'].xml = PAGE`, { PAGE: pageXml });
  ma2.set('Executor 7.2', { label: '主光' });
  ma2.set('Executor 7.3', { label: '副光' });
  let show: ShowState = idleShow;
  const wire = new Ma2NetworkWire(ma2);
  const bridge = new Ma2OnpcBridge(wire, showReader(() => show));
  /** The requests the plugin was asked to begin, in order: id, operation (for beginsync, SYNC), lane and line. */
  const begun = (): Array<{ id: string; operation: string; lane: string; index: number }> => ma2.lines.flatMap((line, index) => {
    const match = /','(begin|beginsync)','([a-f0-9]{32})','([A-Za-z0-9]+)',\d+,\d+,'(bg|fg)'/.exec(line);
    return match ? [{ id: match[2]!, operation: match[1] === 'beginsync' ? 'SYNC' : match[3]!, lane: match[4]!, index }] : [];
  });
  const linesOf = (id: string): number[] => ma2.lines.flatMap((line, index) => rpcOf(line)?.id === id ? [index] : []);
  return {
    ma2, wire, bridge, begun, linesOf,
    setShow: (value: ShowState): void => { show = value; },
    object: (): string => ma2.lua(`return FAKE.objects['Timecode 9902'].xml`)[0]!.toString('utf8'),
    // Request ids are random: the files a run leaves behind are compared by name with the ids taken out.
    files: (): string[] => ma2.exportFiles().map(name => name.replace(/[a-f0-9]{32}/g, 'ID')).sort()
  };
}

/** One sync with nothing in between, and the page read on its own. */
async function straight(): Promise<{ object: string; files: string[]; page: string }> {
  const { bridge, object, files } = rig();
  const snapshot = await bridge.request('SCOPE', 9902, '9903');
  await bridge.request('SYNC', 9902, snapshot, desired);
  const page = await rig().bridge.request('PAGE', 7);
  return { object: object(), files: files(), page };
}

// Every case runs the real plugin in a Lua interpreter written in JavaScript, and the sweep below runs a whole sync
// once per step. That is about half a second here and went past the default 5 s on the loaded Windows runner.
describe('前台只读道（M4）', { timeout: 60000 }, () => {
  it('哪些走前台：只读、短、有人在界面上等；会写控台的一律在后台', () => {
    const foreground: Ma2Operation[] = ['PING', 'PAGES', 'PAGE', 'LIST', 'LISTSEQ', 'EXECUTOR'];
    const background: Ma2Operation[] = ['SEQUENCE', 'SEQCUES', 'READ', 'SNAPSHOT', 'SCOPE', 'TCRANGES', 'DISCARD', 'APPLY', 'SYNC', 'CREATE', 'ASSIGNSEQ', 'LABEL'];
    expect(foreground.map(ma2Lane)).toEqual(foreground.map(() => 'fg'));
    expect(background.map(ma2Lane)).toEqual(background.map(() => 'bg'));
  });

  it('后台同步进行中发 PAGE：在后台下一步之前整个做完；每一步都试一遍，控台最后和不插 PAGE 时一样', async () => {
    const expected = await straight();
    const writeStep = ma2WriteStep('SYNC', timecode, desired)!;
    for (let at = 1; at <= writeStep + 1; at++) {
      const { ma2, wire, bridge, begun, linesOf, object, files } = rig();
      const snapshot = await bridge.request('SCOPE', 9902, '9903');
      expect(wire.lanes).toBe(true);
      let sync: string | null = null; let steps = 0; const pending: { page: Promise<string> | null } = { page: null };
      ma2.beforeLine = line => {
        if (/','beginsync','/.test(line)) sync = rpcOf(line)!.id;
        if (sync && stepLine.test(line) && rpcOf(line)?.id === sync && ++steps === at) pending.page = bridge.request('PAGE', 7);
      };
      await expect(bridge.request('SYNC', 9902, snapshot, desired)).resolves.toContain('time="60"');
      expect(pending.page, `step ${at}`).not.toBeNull();
      expect(await pending.page, `step ${at}`).toBe(expected.page);
      const fg = begun().find(entry => entry.operation === 'PAGE')!;
      expect(fg.lane).toBe('fg');
      const fgLines = linesOf(fg.id);
      expect(ma2.lines[fgLines.at(-1)!]).toContain("','release','");
      const next = linesOf(sync!).find(index => index > fg.index && stepLine.test(ma2.lines[index]!));
      // Before every further step of the sync the page is done whole; only the read-back right after the write goes
      // straight on (the page only reads, under names of its own).
      if (at !== writeStep && next !== undefined) expect(next, `step ${at}`).toBeGreaterThan(fgLines.at(-1)!);
      if (at < writeStep) expect(next, `step ${at}`).toBeDefined();
      expect(object(), `step ${at}`).toBe(expected.object);
      expect(files(), `step ${at}`).toEqual(expected.files);
      expect(ma2.commands().filter(command => command.startsWith('Import '))).toHaveLength(1);
    }
  });

  it('LABEL、ASSIGNSEQ 不插队：排在后台同步后面，同步放掉以后才开始；改执行器之前读的那一页也一样', async () => {
    const { ma2, bridge, begun, linesOf } = rig();
    const snapshot = await bridge.request('SCOPE', 9902, '9903');
    let sync: string | null = null; const queued: Array<Promise<string>> = [];
    ma2.beforeLine = line => {
      if (/','beginsync','/.test(line)) sync = rpcOf(line)!.id;
      if (sync && queued.length === 0 && rpcOf(line)?.action === 'step') {
        queued.push(
          bridge.request('LABEL', 9901, ['sequence', '1', hex('tblink_fake_show'), hex('1000'), hex('A'), hex('改名')].join('\n')),
          bridge.request('ASSIGNSEQ', 9903, `${'ab'.repeat(12)}\n${hex('tblink_fake_show')}\n${hex('1000')}`),
          bridge.request('PAGES', 1),
          // An executor change reads its page behind the sync, so the change it then makes waits too.
          bridge.request('PAGE', 7, '', '', undefined, undefined, 'bg'));
      }
    };
    await bridge.request('SYNC', 9902, snapshot, desired);
    await Promise.all(queued);
    const released = linesOf(sync!).at(-1)!;
    expect(ma2.lines[released]).toContain("','release','");
    const order = begun();
    for (const operation of ['LABEL', 'ASSIGNSEQ', 'PAGE']) {
      const entry = order.find(value => value.operation === operation)!;
      expect(entry.lane).toBe('bg');
      expect(entry.index, operation).toBeGreaterThan(released);
    }
    // The page list, by contrast, went between two steps of the sync.
    const pages = order.find(value => value.operation === 'PAGES')!;
    expect(pages.lane).toBe('fg');
    expect(pages.index).toBeLessThan(released);
  });

  it('节目开始走时两条道各自按 M3 停下：都算等待、都马上放掉，停了以后都照常做完', async () => {
    const expected = await straight();
    for (const flip of ['with the page', 'during the page'] as const) {
      const { ma2, bridge, setShow, linesOf, begun, object } = rig();
      const snapshot = await bridge.request('SCOPE', 9902, '9903');
      let sync: string | null = null; const pending: { page: Promise<unknown> | null } = { page: null };
      ma2.beforeLine = line => {
        const rpc = rpcOf(line);
        if (/','beginsync','/.test(line)) sync = rpc!.id;
        if (sync && !pending.page && rpc?.id === sync && rpc.action === 'step') {
          if (flip === 'with the page') setShow(runningShow);
          pending.page = bridge.request('PAGE', 7).then(() => null, (cause: unknown) => cause);
        }
        // The program starts while the page's own first step runs: the page stops before its next one.
        if (flip === 'during the page' && rpc?.action === 'run' && rpc.id !== sync) setShow(runningShow);
      };
      const stopped = await bridge.request('SYNC', 9902, snapshot, desired).then(() => null, (cause: unknown) => cause);
      expect(isShowWait(stopped), flip).toBe(true);
      expect(stopped instanceof Ma2BridgeFailure && stopped.sent, flip).toBe(false);
      expect(isShowWait(await pending.page), flip).toBe(true);
      const last = begun().slice(-2);
      expect(last.map(entry => entry.operation).sort(), flip).toEqual(['PAGE', 'SYNC']);
      for (const { id } of last) expect(ma2.lines[linesOf(id).at(-1)!], flip).toContain("','release','");
      expect(ma2.commands().filter(command => command.startsWith('Import ')), flip).toEqual([]);
      ma2.beforeLine = null;
      setShow(idleShow);
      await expect(bridge.request('PAGE', 7)).resolves.toBe(expected.page);
      await bridge.request('SYNC', 9902, await bridge.request('SCOPE', 9902, '9903'), desired);
      expect(object(), flip).toBe(expected.object);
    }
  });

  it('后台请求过期不影响前台，前台过期也不影响后台；前台只收只读请求', async () => {
    const { ma2 } = rig();
    const rpc = async (action: string, id: string, args = ''): Promise<string> => {
      const token = randomBytes(16).toString('hex');
      return ma2.command(`Lua "TBLINK_NET('${token}','${action}','${id}'${args})"`, text => ma2ResponseLine(text, `TBLINK_RPC_${token}:`));
    };
    const error = (reply: string): string => reply.startsWith('ERR:') ? Buffer.from(reply.slice(4), 'hex').toString() : `not an error: ${reply}`;
    const id = (index: number): string => index.toString(16).padStart(32, 'd');
    const begin = async (request: string, operation: string, target: number, body: string, lane: string): Promise<string> => {
      const data = Buffer.from(body);
      const reply = await rpc('begin', request, `,'${operation}',${target},${data.length},'${lane}'`);
      if (reply.startsWith('ACK')) for (let offset = 0; offset < data.length; offset += 256) expect(await rpc('chunk', request, `,${offset / 256 + 1},'${data.subarray(offset, offset + 256).toString('hex')}'`)).toBe('ACK');
      return reply;
    };
    const finish = async (request: string, first: string): Promise<string> => {
      let reply = first;
      while (/^STEP:/.test(reply)) reply = await rpc('step', request);
      const size = Number(/^DONE:(\d+)$/.exec(reply)?.[1]);
      const parts: Buffer[] = [];
      for (let offset = 0; offset < size; offset += 256) parts.push(Buffer.from((await rpc('read', request, `,${offset}`)).slice(5), 'hex'));
      expect(await rpc('release', request)).toBe('ACK');
      return Buffer.concat(parts).toString('utf8');
    };
    const ok = (request: string): RegExp => new RegExp(`^${request}\\nOK\\n`);
    // A background request held over several steps; a foreground page runs whole meanwhile.
    expect(await begin(id(1), 'SCOPE', 9902, '9903', 'bg')).toBe('ACK:lanes');
    expect(await rpc('run', id(1), ",'steps'")).toBe('STEP:1');
    expect(await begin(id(2), 'PAGE', 7, '', 'fg')).toBe('ACK:lanes');
    expect(await finish(id(2), await rpc('run', id(2), ",'steps'"))).toMatch(ok(id(2)));
    expect(await rpc('step', id(1))).toBe('STEP:2');
    // The background request expires; the foreground lane goes on as before.
    ma2.lua('FAKE.now = FAKE.now + 121');
    expect(error(await rpc('step', id(1)))).toContain('Network request expired or mismatched');
    expect(await begin(id(3), 'PAGES', 1, '', 'fg')).toBe('ACK:lanes');
    expect(await finish(id(3), await rpc('run', id(3), ",'steps'"))).toMatch(ok(id(3)));
    // A foreground request left behind expires on its own, while the background one, renewed by each step, goes on.
    expect(await begin(id(4), 'LIST', 1, '', 'fg')).toBe('ACK:lanes');
    expect(await begin(id(5), 'SCOPE', 9902, '9903', 'bg')).toBe('ACK:lanes');
    expect(await rpc('run', id(5), ",'steps'")).toBe('STEP:1');
    ma2.lua('FAKE.now = FAKE.now + 60');
    expect(await rpc('step', id(5))).toBe('STEP:2');
    expect(error(await begin(id(6), 'LIST', 1, '', 'fg'))).toContain('Another network request is pending');
    ma2.lua('FAKE.now = FAKE.now + 61');
    expect(error(await rpc('run', id(4), ",'steps'"))).toContain('Network request expired or mismatched');
    expect(await finish(id(5), await rpc('step', id(5)))).toMatch(ok(id(5)));
    // Only reads go on the foreground lane, and none that leaves a snapshot for a later request.
    for (const operation of ['LABEL', 'ASSIGNSEQ', 'APPLY', 'SYNC', 'CREATE', 'SNAPSHOT', 'SCOPE', 'DISCARD', 'READ', 'SEQUENCE', 'SEQCUES', 'TCRANGES']) {
      expect(error(await rpc('begin', id(7), `,'${operation}',9902,0,'fg'`)), operation).toContain('Operation not allowed on the foreground lane');
    }
    // A program that names no lane (one from before lanes, the bridge upgrade check) needs both lanes free.
    expect(await begin(id(8), 'PAGES', 1, '', 'fg')).toBe('ACK:lanes');
    expect(error(await rpc('begin', id(9), ",'PING',1,0"))).toContain('Another network request is pending');
    expect(await rpc('release', id(8))).toBe('ACK');
    expect(await rpc('begin', id(9), ",'PING',1,0")).toBe('ACK');
  });

  it('新联动台配不认道名的旧插件：只走一条道，PAGE 排在同步后面，照常做完', async () => {
    const { ma2, wire, bridge, begun, linesOf } = rig(singleRunBridgeSource);
    const snapshot = await bridge.request('SCOPE', 9902, '9903');
    expect(wire.lanes).toBe(false);
    let sync: string | null = null; let page: Promise<string> | null = null;
    ma2.beforeLine = line => {
      if (!page && /','beginsync','/.test(line)) { sync = rpcOf(line)!.id; page = bridge.request('PAGE', 7); }
    };
    await expect(bridge.request('SYNC', 9902, snapshot, desired)).resolves.toContain('time="60"');
    await expect(page).resolves.toContain('tblink_label="主光"');
    const entry = begun().find(value => value.operation === 'PAGE')!;
    expect(entry.lane).toBe('bg');
    expect(entry.index).toBeGreaterThan(Math.max(...linesOf(sync!)));
  });
});
