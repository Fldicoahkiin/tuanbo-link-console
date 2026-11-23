import { expect, it } from 'vitest';
import { Ma2LuaConsole } from './fixtures/ma2-lua-console';
import { Ma2NetworkWire } from './ma2-network-wire';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { showStopped } from './fixtures/show-gates';

const expectedSource = `${Buffer.from('tblink_fake_show').toString('hex')}\n${Buffer.from('1000').toString('hex')}`;

function fixture(trigger: string, size = 100, data = 'x'.repeat(size)) {
  const console = new Ma2LuaConsole();
  const xml = `<MA><Info datetime="old"/><Sequ index="2"><Cue index="1"><Number number="1" sub_number="500"/>${trigger}<CueDatas>${data}</CueDatas><CuePart index="0" basic_fade="1.2"><macro_text>Go Macro 5</macro_text></CuePart></Cue></Sequ></MA>`;
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
  expect(f.console.lines.length).toBeLessThan(40);
  expect(answer.response.length).toBeLessThan(100);
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

it('恢复选曲辅助 Cue 的 Go 前要求时间线和序列均为本软件所有', async () => {
  const f = fixture('<Trigger type="Follow" data_f="0"/>');
  f.console.set('Timecode 3', { xml: '<MA><Timecode index="2" slot="TC Slot 2"><Track><SubTrack><Event><Cue><No>1</No><No>3</No><No>1</No></Cue></Event></SubTrack></Track></Timecode></MA>' });
  const prepare = () => f.bridge.exchange('SEQGO', 3, expectedSource + '\nselector');
  for (const [marked, unmarked] of [['Timecode 3', 'Sequence 3'], ['Sequence 3', 'Timecode 3']] as const) {
    f.console.lua("FAKE.objects[MARKED].properties={Info='TBLINK_MTC_SELECTOR_V1'};FAKE.objects[UNMARKED].properties={}", { MARKED: marked, UNMARKED: unmarked });
    await expect(prepare()).rejects.toThrow('Selector ownership changed');
    expect(f.console.commands().some(command => command.startsWith('Assign'))).toBe(false);
  }
  f.console.lua("FAKE.objects['Timecode 3'].properties={Info='TBLINK_MTC_SELECTOR_V1'}");
  await expect(prepare()).resolves.toMatchObject({ response: '{"changed":true,"cues":1}' });
  await expect(prepare()).resolves.toMatchObject({ response: '{"changed":false,"cues":0}' });
  expect(f.console.commands().filter(command => command.startsWith('Assign'))).toEqual(['Assign Sequence 3 Cue 1.500 /Trig=Go']);
});

it('手动同步改跳步前再次核对歌曲引用，只更改当前时间线仍在使用的序列', async () => {
  const f = fixture('<Trigger type="Follow"/>');
  const bind = (sequence: number) => f.console.set('Timecode 12', {
    xml: `<MA><Timecode index="11" slot="TC Slot 2"><Track><SubTrack><Event><Cue><No>1</No><No>${sequence}</No><No>1</No></Cue></Event></SubTrack></Track></Timecode></MA>`
  });
  bind(4);
  const prepare = () => f.bridge.exchange('SEQGO', 3, expectedSource + '\n12');
  await expect(prepare()).rejects.toThrow('引用序列刚有变化');
  expect(f.console.commands().some(command => command.startsWith('Assign'))).toBe(false);
  bind(3);
  expect(JSON.parse((await prepare()).response)).toEqual({ changed: true, cues: 1 });
});

it('大于 32 MB 的非 Go 序列在控台内完成修改与完整核对', async () => {
  const f = fixture('<Trigger type="Time" data_f="1"/>', 33 * 1024 * 1024);
  const result = await f.bridge.exchange('SEQGO', 3, expectedSource);
  expect(JSON.parse(result.response)).toEqual({ changed: true, cues: 1 });
  expect(f.console.lines.length).toBeLessThan(65);
  expect(result.response.length).toBeLessThan(100);
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
      if (!line.includes("'begin'") || !line.includes("'SEQGO'")) return;
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

it('密集灯具数据不逐节点消耗 Lua 指令，触发检查及完整比较保持小开销', async () => {
  const node = '<CueData><Channel fixture_id="1" attribute_name="DIM"/><Value>70</Value></CueData>';
  const data = node.repeat(Math.ceil(33 * 1024 * 1024 / node.length));
  const f = fixture('<Trigger type="Time"/>', 0, data);
  // Model the console's Lua instruction pressure, rather than a fast desktop's wall clock.
  // The fixture's export is constant-time and the budget covers the shipped plugin itself.
  f.console.beforeLine = () => f.console.lua("local used=0;debug.sethook(function() used=used+1000;if used>250000 then debug.sethook();error('Lua instruction budget exceeded') end end,'',1000)");
  await expect(f.bridge.exchange('SEQGO', 3, expectedSource)).resolves.toMatchObject({ response: '{"changed":true,"cues":1}' });
  f.console.lua('debug.sethook()');
}, 60_000);

it('灯具数据中的 Trigger 不影响 Cue 触发，块内变化仍拒绝确认', async () => {
  for (const length of [32600, 32760, 32768, 32780, 1048576 + 32760]) {
    const f = fixture('<Trigger type="Time"/>', length);
    f.console.lua(`local xml=FAKE.objects['Sequence 3'].xml
      local first=assert(xml:find('<CueDatas>',1,true))+#'<CueDatas>'
      local finish=assert(xml:find('</CueDatas>',1,true))
      local prefix=xml:sub(1,first-1):gsub('<Trigger type="Time"/>','')
      FAKE.objects['Sequence 3'].xml=prefix..xml:sub(first,finish-1)..'<Trigger type="Time"/>'..xml:sub(finish)`);
    // A Trigger inside fixture payload is not the Cue's trigger and is never stripped.
    await expect(f.bridge.exchange('SEQGO', 3, expectedSource)).resolves.toMatchObject({ response: '{"changed":false,"cues":0}' });
  }
  const f = fixture('<Trigger type="Time"/>', 0, 'x'.repeat(2 * 1024 * 1024) + '<Value>70</Value>');
  f.console.lua("AFTER=AFTER:gsub('<Value>70</Value>','<Value>71</Value>')");
  await expect(f.bridge.exchange('SEQGO', 3, expectedSource)).rejects.toThrow('changed after');
});

it('闭合标签在每个跨块位置都能结束灯具数据并识别其后的 Cue Trigger', async () => {
  const prefix = '<MA><Sequ index="2"><Cue index="1"><Number number="1" sub_number="500"/><CueDatas>';
  for (let tail = 1; tail < '</CueDatas>'.length; tail++) {
    const f = fixture('<Trigger type="Time"/>');
    const xml = prefix + 'x'.repeat(32768 - prefix.length - tail) + '</CueDatas><Trigger type="Time"/><CuePart index="0"/></Cue></Sequ></MA>';
    f.console.lua("FAKE.objects['Sequence 3'].xml=XML;AFTER=XML:gsub('<Trigger type=\"Time\"/>','')", { XML: xml });
    await expect(f.bridge.exchange('SEQGO', 3, expectedSource)).resolves.toMatchObject({ response: '{"changed":true,"cues":1}' });
  }
});

it('大量小 Cue 也按元数据批次返回，保持序列完整且不写入', async () => {
  const f = fixture('');
  const xml = '<MA><Sequ index="2">' + Array.from({ length: 4096 }, (_, i) => `<Cue index="${i + 1}"><Number number="${i + 1}" sub_number="0"/><CueDatas>${'x'.repeat(2048)}</CueDatas><CuePart index="0"/></Cue>`).join('') + '</Sequ></MA>';
  f.console.lua("FAKE.objects['Sequence 3'].xml=XML", { XML: xml });
  f.console.beforeLine = (_, index) => { if (index > 1000) throw new Error('扫描没有按数据量完成'); };
  await expect(f.bridge.exchange('SEQGO', 3, expectedSource)).resolves.toMatchObject({ response: '{"changed":false,"cues":0}' });
  expect(f.console.commands().some(command => command.startsWith('Assign'))).toBe(false);
}, 60_000);

it('MA 内部短暂停顿不单独占用一次网络往返，明确分批边界仍保留', async () => {
  const f = fixture('<Trigger type="Time"/>');
  f.console.lua(`local original=coroutine.resume;local calls=0
    coroutine.resume=function(thread) calls=calls+1;if calls%2==1 then return true end;return original(thread) end`);
  await expect(f.bridge.exchange('SEQGO', 3, expectedSource)).resolves.toMatchObject({ response: '{"changed":true,"cues":1}' });
  expect(f.console.lines.filter(line => line.includes("'step'"))).toHaveLength(3);
  expect(f.console.commands().filter(command => command.startsWith('Assign'))).toHaveLength(1);
});

it('MA 的隐式暂停不能让确认阶段先于 Assign 返回，也不能在确认后再写入', async () => {
  const f = fixture('<Trigger type="Time"/>');
  f.console.lua(`local original=gma.cmd;gma.cmd=function(command)
    local _,main=coroutine.running();if not main then FAKE.now=FAKE.now+1;coroutine.yield() end
    return original(command) end`);
  let verifying = false;
  const command = async (...args: Parameters<typeof f.console.command>) => {
    const before = f.console.commands().filter(line => line.startsWith('Assign')).length;
    const reply = await f.console.command(...args);
    const after = f.console.commands().filter(line => line.startsWith('Assign')).length;
    if (verifying) expect(after).toBe(before);
    if (reply.endsWith(':verify')) { expect(after).toBe(1); verifying = true; }
    return reply;
  };
  const bridge = new Ma2OnpcBridge(new Ma2NetworkWire({ command }), showStopped);
  await expect(bridge.exchange('SEQGO', 3, expectedSource)).resolves.toMatchObject({ response: '{"changed":true,"cues":1}' });
  expect(verifying).toBe(true);
});

it('分批扫描取消关闭文件且不写入，写入后取消只完成核对并保留备份', async () => {
  for (const afterWrite of [false, true]) {
    const f = fixture('<Trigger type="Time"/>', 9 * 1024 * 1024);
    f.console.lua(`OPEN_FILES=0;local original=io.open;io.open=function(...)
      local file=original(...);if not file then return nil end
      OPEN_FILES=OPEN_FILES+1;local close=file.close;file.close=function(self)
        OPEN_FILES=OPEN_FILES-1;return close(self) end;return file end`);
    const controller = new AbortController();
    f.console.beforeLine = line => {
      if (!line.includes("'step'")) return;
      const assigned = f.console.commands().some(command => command.startsWith('Assign'));
      const [opened] = f.console.lua('return OPEN_FILES');
      if (afterWrite ? assigned : Number(opened) > 0) controller.abort(new Error('测试取消'));
    };
    const exchange = f.bridge.exchange('SEQGO', 3, expectedSource, '', controller.signal);
    if (afterWrite) await expect(exchange).resolves.toMatchObject({ response: '{"changed":true,"cues":1}' });
    else await expect(exchange).rejects.toThrow('测试取消');
    expect(f.console.commands().filter(command => command.startsWith('Assign'))).toHaveLength(afterWrite ? 1 : 0);
    expect(Number(f.console.lua('return OPEN_FILES')[0])).toBe(0);
  }
}, 60_000);
