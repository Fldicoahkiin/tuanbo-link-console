import { describe, expect, it } from 'vitest';
import { bridgeSource, Ma2LuaConsole, singleRunBridgeSource } from './fixtures/ma2-lua-console';
import { Ma2NetworkWire } from './ma2-network-wire';
import type { Ma2Operation } from './ma2-onpc-bridge';

// The real tools/ma2/tblink_bridge.lua runs here in a Lua 5.3 interpreter against a fake console
// (fixtures/ma2-fake-console.lua). The baseline is the plugin as it was before it answered step by
// step (fixtures/tblink_bridge.single-run.lua): the same requests must give the same answers, run
// the same console commands in the same order and leave the same files and objects behind.

const hex = (text: string): string => Buffer.from(text).toString('hex');
const requestId = (index: number): string => index.toString(16).padStart(32, 'c');
const timecodeXml = (target: number, cues: Array<[number, number]>, name = `TC${target}`): string => `<?xml version="1.0" encoding="utf-8"?>
<MA major_vers="3" minor_vers="3" stream_vers="4">
\t<Info datetime="@EXPORT@" showfile="tblink_fake_show" />
\t<Timecode index="${target - 1}" name="${name}" offset="0" lenght="${30 * (cues.length + 1)}" slot="TC Slot 1" frame_format="30 FPS">
\t\t<Track index="0" active="true"><SubTrack index="0">${cues.map(([sequence, cue], index) => `<Event index="${index}" time="${15 * (index + 1)}" command="Goto" pressed="true" step="1"><Cue name="Cue ${cue}"><No>1</No><No>${sequence}</No><No>${cue}</No></Cue></Event>`).join('')}</SubTrack></Track>
\t</Timecode>
</MA>
`;
const sequenceXml = (number: number, color = '', extra = ''): string => `<?xml version="1.0" encoding="utf-8"?>
<MA major_vers="3" minor_vers="3" stream_vers="4">
\t<Info datetime="@EXPORT@" />
\t<Sequ index="${number - 1}" name="序列 ${number}">${color ? `<Appearance Color="${color}" />` : ''}
\t\t<Cue index="1"><Number number="1" sub_number="0" /><CuePart index="0" name="一"/><CueDatas><CueData value="1"/></CueDatas></Cue>
\t\t<Cue index="2"><Number number="2" sub_number="500" /><CuePart index="0" name="二"/><CueDatas><CueData value="2"/></CueDatas></Cue>${extra}
\t</Sequ>
</MA>
`;
const executorXml = (sequence: number): string => `<MA><Exec offset_from_first="0"><Assignment name="A"><No>25</No><No>1</No><No>${sequence}</No></Assignment><AssignmentExec><Button>12299</Button></AssignmentExec></Exec></MA>`;
const pageXml = `<MA major_vers="3"><Page index="7"><Exec xsi:nil="true" /><Exec offset_from_first="0"><Assignment name="A"><No>25</No><No>1</No><No>9901</No></Assignment></Exec><Exec offset_from_first="0"><Assignment name="B"><No>25</No><No>1</No><No>9903</No></Assignment></Exec><Exec offset_from_first="0"><Assignment name="C"><No>25</No><No>1</No><No>9901</No></Assignment></Exec></Page></MA>`;

/** A small show: Timecodes 9902 (one Sequence) and 9910 (three), Sequences 9901 and 9903–9905, page 7. */
function show(ma2: Ma2LuaConsole): void {
  ma2.set('Timecode 9902', { xml: timecodeXml(9902, [[9901, 1], [9901, 2]]), name: 'TC9902' });
  ma2.set('Timecode 9910', { xml: timecodeXml(9910, [[9905, 1], [9903, 2], [9904, 1], [9903, 1]]), name: '多序列' });
  for (const [number, color] of [[9901, 'ff8800'], [9903, ''], [9904, '00ff00'], [9905, '']] as const) {
    ma2.set(`Sequence ${number}`, { xml: sequenceXml(number, color), name: `序列 ${number}`, label: `序列 ${number}`, cues: [{ number: '0', label: '零' }, { number: '1', label: '一' }, { number: '2.5', label: '二' }] });
  }
  ma2.set('Sequence 9901 Cue 1', { label: '旧名' });
  ma2.set('Page 7', { label: '第七页' });
  ma2.set('Page 1000', { label: 'TBLINK' });
  ma2.set('Executor 7.2', { label: '主光', xml: executorXml(9901) });
  ma2.set('Executor 7.3', { label: '', xml: executorXml(9903) });
  ma2.set('Executor 7.4', { label: '副\n光', xml: executorXml(9901) });
  ma2.lua(`FAKE.objects['Page 7'].xml = PAGE`, { PAGE: pageXml });
  ma2.set('Executor 99.219', { name: '"执行器" <219>', label: '执行器', xml: executorXml(9901) });
}

type Request = { operation: Ma2Operation; target: number; body?: string; ids?: number };
type Scenario = { name: string; setup?: (ma2: Ma2LuaConsole) => void; requests: Request[] };
const syncBody = (expected: string, desired: string): string => `${Buffer.byteLength(expected)}\n${expected}${desired}`;
const label = (kind: string, cue: string, old: string, name: string, session = '1000'): string => [kind, cue, hex('tblink_fake_show'), hex(session), hex(old), hex(name)].join('\n');
const assign = (owner = 'ab'.repeat(12)): string => [owner, hex('tblink_fake_show'), hex('1000')].join('\n');
/** Changes Sequence `number` right after the console's n-th command. */
const changeSequenceAfter = (command: number, number: number) => (ma2: Ma2LuaConsole): void => {
  ma2.lua(`FAKE.after[${command}] = function() FAKE.objects['Sequence ${number}'].xml = CHANGED end`, { CHANGED: sequenceXml(number, '', '<Cue index="3"><Number number="3" sub_number="0" /></Cue>') });
};
const changeTimecodeAfter = (command: number, target: number) => (ma2: Ma2LuaConsole): void => {
  ma2.lua(`FAKE.after[${command}] = function() FAKE.objects['Timecode ${target}'].xml = CHANGED end`, { CHANGED: timecodeXml(target, [[9901, 2]]) });
};

// Each scenario's requests run on one wire, so SYNC after SNAPSHOT goes through beginsync as in the app.
const scenarios: Scenario[] = [
  { name: 'DISCARD', setup: ma2 => ma2.lua(`FAKE.files['/fake/importexport/tblink_backup_${'a'.repeat(32)}.xml'] = 'x'`), requests: [{ operation: 'DISCARD', target: 1, body: `tblink_backup_${'a'.repeat(32)},tblink_label_${'b'.repeat(32)}` }, { operation: 'DISCARD', target: 1, body: '../show' }] },
  { name: 'PAGES', requests: [{ operation: 'PAGES', target: 1 }] },
  { name: 'PAGE', requests: [{ operation: 'PAGE', target: 7 }, { operation: 'PAGE', target: 7 }, { operation: 'PAGE', target: 8 }] },
  { name: 'LABEL', requests: [{ operation: 'LABEL', target: 9901, body: label('single', '1', '旧名', 'New name') }, { operation: 'LABEL', target: 9901, body: label('sequence', '1', '序列 9901', 'Renamed') }, { operation: 'LABEL', target: 9901, body: label('single', '1', 'other', 'X') }, { operation: 'LABEL', target: 9901, body: label('single', '1', '旧名', 'X', '999') }] },
  { name: 'ASSIGNSEQ new page', requests: [{ operation: 'ASSIGNSEQ', target: 9901, body: assign() }, { operation: 'ASSIGNSEQ', target: 9901, body: assign() }, { operation: 'ASSIGNSEQ', target: 9903, body: assign() }] },
  { name: 'ASSIGNSEQ owned page', setup: ma2 => { ma2.set('Page 999', { label: `TBLINK_${'ab'.repeat(12)}` }); ma2.set('Executor 999.101', { label: '', xml: executorXml(9905) }); ma2.set('Executor 999.103', { label: '', xml: executorXml(9904) }); }, requests: [{ operation: 'ASSIGNSEQ', target: 9904, body: assign() }, { operation: 'ASSIGNSEQ', target: 9901, body: assign() }, { operation: 'ASSIGNSEQ', target: 9999, body: assign() }] },
  { name: 'LIST LISTSEQ', requests: [{ operation: 'LIST', target: 1 }, { operation: 'LISTSEQ', target: 1 }] },
  { name: 'TCRANGES', requests: [{ operation: 'TCRANGES', target: 1 }] },
  { name: 'SEQUENCE', requests: [{ operation: 'SEQUENCE', target: 9901 }, { operation: 'SEQUENCE', target: 9903, body: 'keep' }, { operation: 'SEQUENCE', target: 9999 }] },
  { name: 'SEQUENCE changed during read', setup: changeSequenceAfter(1, 9901), requests: [{ operation: 'SEQUENCE', target: 9901 }] },
  { name: 'SEQCUES', requests: [{ operation: 'SEQCUES', target: 9901, body: '2.500,7.000' }, { operation: 'SEQCUES', target: 9901, body: '2.5' }] },
  { name: 'EXECUTOR', requests: [{ operation: 'EXECUTOR', target: 99, body: '219' }, { operation: 'EXECUTOR', target: 99, body: '220' }] },
  { name: 'EXECUTOR changed during read', setup: ma2 => ma2.lua(`FAKE.after[1] = function() FAKE.objects['Executor 99.219'].xml = CHANGED end`, { CHANGED: executorXml(9903) }), requests: [{ operation: 'EXECUTOR', target: 99, body: '219' }] },
  { name: 'CREATE', requests: [{ operation: 'CREATE', target: 9920, body: `0\n<MA><Timecode index="9919" name="新建" /></MA>` }, { operation: 'CREATE', target: 9920, body: `0\n<MA><Timecode index="9919" name="again" /></MA>` }, { operation: 'CREATE', target: 9921, body: `0\n<MA><Timecode index="9919" name="wrong" /></MA>` }] },
  { name: 'READ', requests: [{ operation: 'READ', target: 9902 }, { operation: 'READ', target: 9999 }, { operation: 'READ', target: 100000 }] },
  { name: 'SNAPSHOT', requests: [{ operation: 'SNAPSHOT', target: 9910 }, { operation: 'SNAPSHOT', target: 9902 }] },
  { name: 'SNAPSHOT Sequence changed between its two exports', setup: changeSequenceAfter(2, 9903), requests: [{ operation: 'SNAPSHOT', target: 9910 }] },
  // Not caught, before or after: a Sequence changed after its own check. Same window as before steps.
  { name: 'SNAPSHOT Sequence changed after its check', setup: changeSequenceAfter(4, 9903), requests: [{ operation: 'SNAPSHOT', target: 9910 }] },
  { name: 'SNAPSHOT Timecode changed', setup: changeTimecodeAfter(3, 9902), requests: [{ operation: 'SNAPSHOT', target: 9902 }] },
  { name: 'SNAPSHOT missing Sequence', setup: ma2 => ma2.remove('Sequence 9904'), requests: [{ operation: 'SNAPSHOT', target: 9910 }] },
  { name: 'SCOPE', requests: [{ operation: 'SCOPE', target: 9902, body: '9905,9903' }, { operation: 'SCOPE', target: 9902, body: '9901,9901' }] }
];

/** APPLY and SYNC need what an earlier request returned, so they are written as steps of their own. */
type Flow = { name: string; setup?: (ma2: Ma2LuaConsole) => void; run: (exchange: (request: Request) => Promise<string>, ma2: Ma2LuaConsole) => Promise<void> };
const flows: Flow[] = [
  { name: 'APPLY', run: async exchange => {
    const current = await exchange({ operation: 'READ', target: 9902 });
    await exchange({ operation: 'APPLY', target: 9902, body: syncBody(current, timecodeXml(9902, [[9901, 2]], '改')) });
    await exchange({ operation: 'APPLY', target: 9902, body: syncBody(current, timecodeXml(9902, [[9901, 1]], '旧快照')) });
  } },
  { name: 'APPLY Timecode changed before write', run: async (exchange, ma2) => {
    const current = await exchange({ operation: 'READ', target: 9902 });
    changeTimecodeAfter(ma2.commands().length + 1, 9902)(ma2);
    await exchange({ operation: 'READ', target: 9902 });
    await exchange({ operation: 'APPLY', target: 9902, body: syncBody(current, timecodeXml(9902, [[9901, 2]])) });
  } },
  { name: 'SYNC after SNAPSHOT', run: async exchange => {
    const snapshot = await exchange({ operation: 'SNAPSHOT', target: 9910 });
    await exchange({ operation: 'SYNC', target: 9910, body: syncBody(snapshot, timecodeXml(9910, [[9903, 1], [9904, 2]], '写入')) });
    const again = await exchange({ operation: 'SCOPE', target: 9910, body: '9901' });
    await exchange({ operation: 'SYNC', target: 9910, body: syncBody(again, timecodeXml(9910, [[9901, 1]], '再写')) });
  } },
  { name: 'SYNC with an outdated snapshot', run: async exchange => {
    const snapshot = await exchange({ operation: 'SNAPSHOT', target: 9910 });
    await exchange({ operation: 'SYNC', target: 9910, body: syncBody(snapshot.replace('序列 9903', '序列 X'), timecodeXml(9910, [[9903, 1]])) });
  } },
  { name: 'SYNC Sequence changed during preflight', run: async (exchange, ma2) => {
    const snapshot = await exchange({ operation: 'SNAPSHOT', target: 9910 });
    changeSequenceAfter(ma2.commands().length + 2, 9903)(ma2);
    await exchange({ operation: 'SYNC', target: 9910, body: syncBody(snapshot, timecodeXml(9910, [[9903, 1]])) });
  } },
  // Not caught, before or after: a Sequence changed after its own check in the preflight (only the
  // Timecode is compared again in the write step). Kept here so the window stays visible.
  { name: 'SYNC Sequence changed after its check', run: async (exchange, ma2) => {
    const snapshot = await exchange({ operation: 'SNAPSHOT', target: 9910 });
    changeSequenceAfter(ma2.commands().length + 3, 9903)(ma2);
    await exchange({ operation: 'SYNC', target: 9910, body: syncBody(snapshot, timecodeXml(9910, [[9903, 1]])) });
  } },
  { name: 'SYNC Timecode changed after preflight', run: async (exchange, ma2) => {
    const snapshot = await exchange({ operation: 'SNAPSHOT', target: 9902 });
    changeTimecodeAfter(ma2.commands().length + 4, 9902)(ma2);
    await exchange({ operation: 'SYNC', target: 9902, body: syncBody(snapshot, timecodeXml(9902, [[9901, 1]])) });
  } }
];

/** What the single-run plugin answers; the stepped plugin must answer the same (checked above it). */
const baseline: Record<string, string[]> = {
  DISCARD: ['OK', 'MA2：Invalid backup name'],
  PAGES: ['OK'],
  PAGE: ['OK', 'OK', 'MA2：Executor Page does not exist'],
  LABEL: ['OK', 'OK', 'MA2：Console name changed; read console before retrying', 'MA2：Show or session changed; name not written'],
  'ASSIGNSEQ new page': ['OK', 'OK', 'OK'],
  'ASSIGNSEQ owned page': ['OK', 'OK', 'MA2：Sequence missing'],
  'LIST LISTSEQ': ['OK', 'OK'],
  TCRANGES: ['OK'],
  SEQUENCE: ['OK', 'OK', 'MA2：Sequence missing'],
  'SEQUENCE changed during read': ['MA2：Sequence changed during read'],
  SEQCUES: ['OK', 'MA2：Invalid Cue number'],
  EXECUTOR: ['OK', 'MA2：Executor does not exist'],
  'EXECUTOR changed during read': ['MA2：Executor changed during read'],
  CREATE: ['OK', 'MA2：Timecode already exists; creation refused', 'MA2：Creation target mismatch'],
  READ: ['OK', 'MA2：Timecode does not exist', '无效的 MA2 网络请求'],
  SNAPSHOT: ['OK', 'OK'],
  'SNAPSHOT Sequence changed between its two exports': ['MA2：Sequence changed during snapshot'],
  'SNAPSHOT Sequence changed after its check': ['OK'],
  'SNAPSHOT Timecode changed': ['MA2：Timecode changed during snapshot'],
  'SNAPSHOT missing Sequence': ['MA2：Referenced Sequence is missing'],
  SCOPE: ['OK', 'MA2：Invalid Sequence scope'],
  APPLY: ['OK', 'OK', 'MA2：Timecode changed after preview'],
  'APPLY Timecode changed before write': ['OK', 'OK', 'MA2：Timecode changed after preview'],
  'SYNC after SNAPSHOT': ['OK', 'OK', 'OK', 'OK'],
  'SYNC with an outdated snapshot': ['OK', 'MA2：Timecode or Sequence changed after preview'],
  'SYNC Sequence changed during preflight': ['OK', 'MA2：Sequence changed during snapshot'],
  'SYNC Sequence changed after its check': ['OK', 'OK'],
  'SYNC Timecode changed after preflight': ['OK', 'MA2：Timecode changed before write']
};

type Outcome = { results: string[]; commands: string[]; state: Buffer };
// Positions in Lua's own error messages move with the source; the message itself must not.
const normalize = (message: string): string => message.replace(/\[string "tblink_bridge"\]:\d+: /g, '');
async function record(source: string, setup: ((ma2: Ma2LuaConsole) => void) | undefined, run: Flow['run']): Promise<Outcome> {
  const ma2 = new Ma2LuaConsole(source);
  show(ma2); setup?.(ma2);
  const wire = new Ma2NetworkWire(ma2);
  const results: string[] = [];
  let index = 0;
  const exchange = async (request: Request): Promise<string> => {
    try {
      const value = await wire.exchange(requestId(index++), request.operation, request.target, request.body ?? '', () => undefined);
      results.push(`OK ${value}`); return value;
    } catch (error) { results.push(`ERROR ${normalize(error instanceof Error ? error.message : String(error))}`); return ''; }
  };
  await run(exchange, ma2);
  // Every request released its transaction: the next one can begin.
  await expect(wire.exchange(requestId(999), 'LIST', 1, '', () => undefined)).resolves.toContain('"entries"');
  return { results, commands: ma2.commands(), state: ma2.state() };
}
const flow = (name: string): Flow['run'] => { const found = flows.find(entry => entry.name === name); if (!found) throw new Error(name); return found.run; };
const sequential = (requests: Request[]): Flow['run'] => async exchange => { for (const request of requests) await exchange(request); };

describe('插件真实代码：和一次做完的旧插件结果逐字节一样', () => {
  it.each(scenarios)('$name', async scenario => {
    const before = await record(singleRunBridgeSource, scenario.setup, sequential(scenario.requests));
    expect(before.results.map(result => result.startsWith('OK ') ? 'OK' : result.slice(6))).toEqual(baseline[scenario.name]);
    expect(await record(bridgeSource, scenario.setup, sequential(scenario.requests))).toEqual(before);
  });
  it.each(flows)('$name', async flow => {
    const before = await record(singleRunBridgeSource, flow.setup, flow.run);
    expect(before.results.map(result => result.startsWith('OK ') ? 'OK' : result.slice(6))).toEqual(baseline[flow.name]);
    expect(await record(bridgeSource, flow.setup, flow.run)).toEqual(before);
  });
});

describe('旧插件上录下的基线本身是对的', () => {
  it('SYNC：预检快照逐个序列导出两次、写入前备份、Import、写后导出，顺序固定', async () => {
    const outcome = await record(singleRunBridgeSource, undefined, flow('SYNC after SNAPSHOT'));
    expect(outcome.results.slice(0, 2).every(result => result.startsWith('OK '))).toBe(true);
    const id = requestId(1);
    const write = outcome.commands.slice(outcome.commands.findIndex(command => command.includes(`tblink_snapshot_${id}_preflight`)));
    expect(write.slice(0, 12)).toEqual([
      `Export Timecode 9910 "tblink_snapshot_${id}_preflight" /o`,
      `Export Sequence 9903 "tblink_sequence_${id}_preflight_9903" /o`, `Export Sequence 9903 "tblink_sequence_${id}_preflight_9903_verify" /o`,
      `Export Sequence 9904 "tblink_sequence_${id}_preflight_9904" /o`, `Export Sequence 9904 "tblink_sequence_${id}_preflight_9904_verify" /o`,
      `Export Sequence 9905 "tblink_sequence_${id}_preflight_9905" /o`, `Export Sequence 9905 "tblink_sequence_${id}_preflight_9905_verify" /o`,
      `Export Timecode 9910 "tblink_snapshot_verify_${id}_preflight" /o`,
      `Export Timecode 9910 "tblink_backup_${id}" /o`,
      `Import "tblink_write_${id}.xml" At Timecode 9910 /o /nc`,
      `Export Timecode 9910 "tblink_verify_${id}" /o`,
      `Export Timecode 9910 "tblink_snapshot_${requestId(2)}" /o`
    ]);
    // Only write backups stay on the console.
    expect(outcome.state.toString()).toContain(`tblink_backup_${id}.xml`);
    expect(outcome.state.toString()).not.toContain(`tblink_write_${id}.xml`);
  });
  it('控台在预检中途被改：拦住，不写', async () => {
    const outcome = await record(singleRunBridgeSource, undefined, flow('SYNC Sequence changed during preflight'));
    expect(outcome.results[1]).toBe('ERROR MA2：Sequence changed during snapshot');
    expect(outcome.commands.some(command => command.startsWith('Import'))).toBe(false);
  });
  it('预检之后、写入之前时间码被改：拦住，不写', async () => {
    const outcome = await record(singleRunBridgeSource, undefined, flow('SYNC Timecode changed after preflight'));
    expect(outcome.results[1]).toBe('ERROR MA2：Timecode changed before write');
    expect(outcome.commands.some(command => command.startsWith('Import'))).toBe(false);
  });
  it('本机文件桥：一个请求文件，一次答完', () => {
    for (const source of [singleRunBridgeSource, bridgeSource]) {
      const ma2 = new Ma2LuaConsole(source, 'file');
      show(ma2);
      const id = requestId(5);
      expect(ma2.poll(`${id}\nREAD\n9902\n0\n`)).toMatch(new RegExp(`^${id}\\nOK\\n\\d+\\n<\\?xml`));
      expect(ma2.poll(`${requestId(6)}\nSNAPSHOT\n9910\n0\n`)).toContain('<Sequ index="9902"');
    }
  });
});
