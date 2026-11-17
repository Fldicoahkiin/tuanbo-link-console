import { expect, it } from 'vitest';
import { Ma2LuaConsole } from './fixtures/ma2-lua-console';
import { Ma2NetworkWire } from './ma2-network-wire';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { showStopped } from './fixtures/show-gates';

const expectedSource = `${Buffer.from('tblink_fake_show').toString('hex')}\n${Buffer.from('1000').toString('hex')}`;

function fixture(trigger: string, size = 100, data = 'x'.repeat(size)) {
  const console = new Ma2LuaConsole();
  const xml = `<MA><Info datetime="old"/><Sequ index="2"><Cue index="1"><Number number="1" sub_number="500"/>${trigger}<CuePart index="0" basic_fade="1.2"><macro_text>Go Macro 5</macro_text><Data>${data}</Data></CuePart></Cue></Sequ></MA>`;
  console.set('Sequence 3', { xml });
  console.lua(`local original=gma.cmd;gma.cmd=function(command)
    if command:match('^Export Sequence 3 ') then
      FAKE.log[#FAKE.log+1]=command
      local name=assert(command:match('"([%w_]+)"'))
      FAKE.files['/fake/importexport/'..name..'.xml']=FAKE.objects['Sequence 3'].xml
    elseif command=='Assign Sequence 3 Cue 1.500 /Trig=Go' then
      FAKE.log[#FAKE.log+1]=command
      FAKE.objects['Sequence 3'].xml=AFTER
    else original(command) end
  end`, { AFTER: xml.replace(trigger, '').replace('datetime="old"', 'datetime="new"') });
  return { console, bridge: new Ma2OnpcBridge(new Ma2NetworkWire(console), showStopped) };
}

it('超过 32 MB 的 Go 序列只返回摘要，不跨网络传灯具数据', async () => {
  const f = fixture('', 33 * 1024 * 1024);
  const answer = await f.bridge.exchange('SEQGO', 3, expectedSource);
  expect(JSON.parse(answer.response)).toEqual({ changed: false, cues: 0 });
  expect(f.console.lines.length).toBeLessThan(12);
  expect(f.console.commands().some(line => line.startsWith('Assign'))).toBe(false);
  expect(f.console.exportFiles()).toEqual([]);
}, 60_000);

it('控台内修改触发、备份并逐字核对其余灯具和命令内容', async () => {
  const f = fixture('<Trigger type="Follow" data_f="1"/>', 150_000);
  const result = await f.bridge.exchange('SEQGO', 3, expectedSource);
  expect(JSON.parse(result.response)).toEqual({ changed: true, cues: 1 });
  expect(f.console.commands()).toContain('Assign Sequence 3 Cue 1.500 /Trig=Go');
  expect(f.console.exportFiles()).toEqual([`tblink_library_${result.requestId}.xml`]);
});

it('大于 32 MB 的非 Go 序列在控台内完成修改与完整核对', async () => {
  const f = fixture('<Trigger type="Time" data_f="1"/>', 33 * 1024 * 1024);
  const result = await f.bridge.exchange('SEQGO', 3, expectedSource);
  expect(JSON.parse(result.response)).toEqual({ changed: true, cues: 1 });
  expect(f.console.lines.length).toBeLessThan(12);
  expect(f.console.exportFiles()).toEqual([`tblink_library_${result.requestId}.xml`]);
}, 60_000);

it('取消、播放开始、Show 切换均在写入前停止，释放后可再读', async () => {
  for (const reason of ['cancel', 'show', 'playing'] as const) {
    const f = fixture('<Trigger type="Time" data_f="1"/>');
    const controller = new AbortController();
    let playing = false;
    const wire = new Ma2NetworkWire(f.console);
    const bridge = new Ma2OnpcBridge(wire, operation => playing ? { kind: 'wait', message: '节目在走，请先停止', until: 'clock-stopped' } : showStopped(operation));
    f.console.beforeLine = line => {
      if (!line.includes("'run'")) return;
      if (reason === 'cancel') controller.abort();
      if (reason === 'playing') playing = true;
    };
    if (reason === 'show') f.console.beforeLine = line => { if (line.includes("'step'")) f.console.lua("FAKE.vars.SHOWFILE='changed'"); };
    await expect(bridge.exchange('SEQGO', 3, expectedSource, '', controller.signal)).rejects.toThrow();
    expect(f.console.commands().some(command => command.startsWith('Assign'))).toBe(false);
    expect(wire.unreleasedRequests).toEqual([]);
    f.console.beforeLine = null; playing = false;
    f.console.lua("FAKE.vars.SHOWFILE='tblink_fake_show'");
    await expect(bridge.exchange('SEQGO', 3, expectedSource)).resolves.toMatchObject({ response: '{"changed":true,"cues":1}' });
  }
});

it('写入前内容变化拒绝修改，写入后灯具变化拒绝确认', async () => {
  for (const before of [true, false]) {
    const f = fixture('<Trigger type="Time" data_f="1"/>');
    if (!before) f.console.lua("AFTER=AFTER:gsub('Go Macro 5','Go Macro 6')");
    // This fixture's export bypasses the fake command hooks, so edit between the plugin steps.
    if (before) f.console.beforeLine = line => { if (line.includes("'step'")) f.console.lua("FAKE.objects['Sequence 3'].xml=FAKE.objects['Sequence 3'].xml:gsub('basic_fade=\"1.2\"','basic_fade=\"2.4\"')"); };
    await expect(f.bridge.exchange('SEQGO', 3, expectedSource)).rejects.toThrow(before ? 'changed before' : 'changed after');
    if (before) expect(f.console.commands().some(line => line.startsWith('Assign'))).toBe(false);
    expect(f.console.exportFiles().some(name => /^tblink_library_[a-f0-9]{32}\.xml$/.test(name))).toBe(true);
  }
});

it('Go 序列也核对两次导出，不把并发改动当成已确认', async () => {
  const f = fixture('');
  f.console.beforeLine = line => { if (line.includes("'step'")) f.console.lua("FAKE.objects['Sequence 3'].xml=FAKE.objects['Sequence 3'].xml:gsub('<CuePart','<Trigger type=\"Time\"/><CuePart')"); };
  await expect(f.bridge.exchange('SEQGO', 3, expectedSource)).rejects.toThrow('changed before');
  expect(f.console.commands().some(line => line.startsWith('Assign'))).toBe(false);
});

it('密集灯具节点跨扫描块保持原样，空白命令内容不被忽略', async () => {
  const data = '<Fixture id="5"><Value attribute="Dimmer" value="0.250000"/></Fixture>'.repeat(1200);
  const f = fixture('<Trigger type="Follow"/>', 0, data);
  await expect(f.bridge.exchange('SEQGO', 3, expectedSource)).resolves.toMatchObject({ response: '{"changed":true,"cues":1}' });
  const changed = fixture('<Trigger type="Time"/>', 0, data);
  changed.console.lua("AFTER=AFTER:gsub('Go Macro 5','  Go Macro 5  ')");
  await expect(changed.bridge.exchange('SEQGO', 3, expectedSource)).rejects.toThrow('changed after');
});

it('导出缺失或编号错误不得返回已确认，也不写入', async () => {
  for (const xml of ['', '<MA/>', '<MA><Sequ index="3"/></MA>']) {
    const f = fixture('');
    f.console.lua("FAKE.objects['Sequence 3'].xml=INVALID", { INVALID: xml });
    await expect(f.bridge.exchange('SEQGO', 3, expectedSource)).rejects.toThrow(/Sequence export/);
    expect(f.console.commands().some(line => line.startsWith('Assign'))).toBe(false);
  }
});
