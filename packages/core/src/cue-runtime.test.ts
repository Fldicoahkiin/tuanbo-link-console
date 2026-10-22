import { describe, expect, it } from 'vitest';
import { parseLinkProject, type LinkProject, type MtcFrameRate } from '@tb/schema';
import { CueRuntime, isMtcSampleContinuous } from './cue-runtime';
import { frameNumberToTimecode, type MtcSample } from './mtc-timecode';

describe('CueRuntime', () => {
  it('后台观察模式不派发或认领执行结果，不能被 P1 或通用 MIDI 绕过断流保护', () => {
    const value = { ...project(), playbackSource: 'internal' as const };
    const runtime = new CueRuntime(value); runtime.selectItem('item'); runtime.beginPreflight('live');
    runtime.arm(0, sample(30, 0), 'awaiting-external-start', 'external');
    expect(runtime.tick(4000)).toMatchObject({ state: 'armed', dueCues: [], missedCueIds: [] });
    expect(runtime.ingest(sample(120, 4000))).toMatchObject({ state: 'running', dueCues: [], missedCueIds: [] });
    expect(runtime.manualGo('cue-1').dueCues).toEqual([]);
    runtime.pauseAutomatic(); expect(runtime.resumeMedia(sample(126, 9000)).state).toBe('running');
    runtime.stop(); runtime.completeStop(); runtime.beginPreflight('live'); runtime.arm(10000);
    // Local Cues on the formal audio clock: a quiet observer is not a loss, a jump still freezes.
    runtime.ingest(sample(0, 10000)); expect(runtime.tick(10501).state).toBe('running');
    expect(runtime.ingest(sample(300, 10600)).state).toBe('timecodeLost');
    for (const source of ['p1', 'internal'] as const) {
      const blocked = project(); blocked.playbackSource = source;
      if (source === 'internal') blocked.rundown[0]!.cues[0]!.actions = [{ id: 'midi', label: '不可旁路', kind: 'midi.noteOn', portProfileId: 'out', channel: 1, note: 60, velocity: 100 }];
      const execution = new CueRuntime(blocked); execution.selectItem('item'); execution.beginPreflight('live');
      expect(execution.arm(0, null, 'awaiting-external-start', 'external').state).toBe('error');
    }
  });
  it('下一 Cue 使用运行索引，手动执行不受最近报告淘汰影响，重新布防重置', () => {
    const runtime = new CueRuntime(project());
    runtime.selectItem('item'); runtime.beginPreflight('live'); runtime.arm(0);
    expect(runtime.getNextCueId()).toBe('cue-1');
    runtime.ingest(sample(0, 0)); runtime.tick(501); runtime.enableManualTakeover();
    expect(runtime.manualGo('cue-1').dueCues).toHaveLength(1);
    expect(runtime.getNextCueId()).toBe('cue-2');
    expect(runtime.manualGo('cue-2').dueCues).toHaveLength(1);
    expect(runtime.getNextCueId()).toBeNull();
    runtime.stop(); runtime.completeStop(); runtime.beginPreflight('live'); runtime.arm(1000);
    expect(runtime.getNextCueId()).toBe('cue-1');
  });
  it('下一 Cue 不显示隐藏层或自动生成的结束动作，保持同帧原顺序', () => {
    const value = project(), item = value.rundown[0]!;
    item.visualLayers.push({ id: 'hidden', name: '隐藏层', visible: false, locked: false });
    item.cues[0]!.durationMs = 100;
    item.cues[0]!.actions = [{ id: 'show', label: '显示', kind: 'obs.setSceneItemEnabled', sceneName: '场景', sourceName: '机位', enabled: true }];
    item.cues.push({ ...item.cues[1]!, id: 'same-frame' }, { ...item.cues[0]!, id: 'hidden-cue', layerId: 'hidden', timecode: frameNumberToTimecode(0, '30') });
    const runtime = new CueRuntime(value); runtime.selectItem('item');
    expect(runtime.getNextCueId()).toBe('cue-1');
    expect(runtime.getNextCueId(30)).toBe('cue-2');
    expect(runtime.getNextCueId(60)).toBeNull();
  });
  it('本机音频准备后重建时钟基准，保留已执行 Cue；观察间隔不当作断流，位置不一致仍拒绝', () => {
    const runtime = new CueRuntime({ ...project(), playbackSource: 'internal' });
    runtime.selectItem('item'); runtime.beginPreflight('live'); runtime.arm(0);
    expect(runtime.ingest(sample(30, 1000)).dueCues.map(due => due.cue.id)).toEqual(['cue-1']);
    expect(runtime.anchorMediaClock(sample(30, 5000)).state).toBe('running');
    expect(runtime.ingest(sample(31, 5034)).dueCues).toEqual([]);
    expect(runtime.tick(5600).state).toBe('running');
    expect(runtime.anchorMediaClock(sample(20, 5700)).state).toBe('error');
  });
  it('本机音频时钟：界面卡顿超过 500ms 不判定时间码丢失，期间 Cue 记为错过且不补发，之后的 Cue 照常执行', () => {
    const runtime = new CueRuntime({ ...project(), playbackSource: 'internal' });
    runtime.selectItem('item'); runtime.beginPreflight('live'); runtime.arm(0);
    runtime.ingest(sample(0, 0)); runtime.ingest(sample(3, 100));
    expect(runtime.tick(1200).state).toBe('running');
    const gap = runtime.ingest(sample(45, 1500));
    expect(gap).toMatchObject({ state: 'running', dueCues: [], missedCueIds: ['cue-1'] });
    expect(gap.reason).toBe('播放位置更新中断 1400ms，错过 1 个联动 Cue，未补发');
    runtime.ingest(sample(46, 1534));
    expect(runtime.ingest(sample(60, 2000))).toMatchObject({ state: 'running', missedCueIds: ['cue-1'] });
    expect(runtime.getNextCueId(60)).toBeNull();
  });
  it('错过的显示来源不再在结束帧隐藏：卡顿与从当前位置布防都不留下孤立的隐藏动作', () => {
    const value = { ...project(), playbackSource: 'internal' as const };
    value.rundown[0]!.cues = [{ id: 'show', name: '显示来源', timecode: frameNumberToTimecode(30, '30'), durationMs: 3_000, enabled: true, notes: '', layerId: 'layer',
      actions: [{ id: 'show-action', label: '显示来源 · 扑克牌', kind: 'obs.setSceneItemEnabled', sceneName: '团播联动台输出', sourceName: '扑克牌', enabled: true }] }];
    const gap = new CueRuntime(value); gap.selectItem('item'); gap.beginPreflight('live'); gap.arm(0);
    gap.ingest(sample(0, 0)); gap.ingest(sample(27, 900));
    const stalled = gap.ingest(sample(48, 1_600));
    expect(stalled).toMatchObject({ state: 'running', dueCues: [], missedCueIds: ['show'] });
    expect(stalled.reason).toContain('错过 1 个联动 Cue');
    for (let frame = 60; frame <= 120; frame += 30) expect(gap.ingest(sample(frame, 1_600 + (frame - 48) * 1000 / 30)).dueCues).toEqual([]);
    const current = new CueRuntime(value); current.selectItem('item'); current.beginPreflight('live');
    expect(current.arm(0, sample(45, 0)).missedCueIds).toEqual(['show']);
    for (let frame = 60; frame <= 120; frame += 15) expect(current.ingest(sample(frame, (frame - 45) * 1000 / 30)).dueCues).toEqual([]);
  });
  it('本机音频时钟位置与经过时间不符的跳变、外部 MTC 的断流仍冻结自动 Cue', () => {
    const internal = new CueRuntime({ ...project(), playbackSource: 'internal' });
    internal.selectItem('item'); internal.beginPreflight('live'); internal.arm(0);
    internal.ingest(sample(0, 0));
    expect(internal.ingest(sample(300, 100)).state).toBe('timecodeLost');
    const external = new CueRuntime(project());
    external.selectItem('item'); external.beginPreflight('live'); external.arm(0);
    external.ingest(sample(0, 0)); external.ingest(sample(3, 100));
    expect(external.ingest(sample(45, 1500)).state).toBe('timecodeLost');
  });
  it('本机时钟准备接口不能掩盖位置跳变或用于 P1 模式', () => {
    for (const source of ['internal', 'p1'] as const) {
      const runtime = new CueRuntime({ ...project(), playbackSource: source });
      runtime.selectItem('item'); runtime.beginPreflight('live'); runtime.arm(0);
      runtime.ingest(sample(0, 0));
      expect(runtime.anchorMediaClock(sample(source === 'internal' ? 30 : 0, 2000)).state).toBe('error');
    }
  });
  it('空闲监听 MTC 时不要求先选节目，也不改变运行状态', () => {
    const runtime = new CueRuntime(project());
    expect(runtime.ingest(sample(30, 1_000))).toMatchObject({ state: 'idle', dueCues: [], missedCueIds: [] });
  });

  it('独立判断 MTC 样本连续性，拒绝超时、倒退、跳变和帧率变化', () => {
    const previous = sample(30, 1_000);
    expect(isMtcSampleContinuous(previous, sample(32, 1_067))).toBe(true);
    expect(isMtcSampleContinuous(previous, sample(60, 2_000))).toBe(false);
    expect(isMtcSampleContinuous(previous, sample(0, 1_067))).toBe(false);
    expect(isMtcSampleContinuous(previous, sample(60, 1_067))).toBe(false);
    expect(isMtcSampleContinuous(previous, sample(32, 1_067, '25'))).toBe(false);
  });

  it('允许操作员显式暂停和恢复自动联动', () => {
    const runtime = new CueRuntime(project());
    runtime.selectItem('item');
    runtime.beginPreflight('rehearsal');
    runtime.arm();
    expect(runtime.pauseAutomatic().state).toBe('paused');
    expect(runtime.resumeAutomatic().state).toBe('armed');
  });

  it('每次布防都会建立新执行会话，停止后第二轮仍可触发同一 Cue', () => {
    const runtime = new CueRuntime(project());
    runtime.selectItem('item');
    runtime.beginPreflight('rehearsal');
    runtime.arm();
    expect(runtime.ingest(sample(30, 1_000)).dueCues.map((due) => due.cue.id)).toEqual(['cue-1']);
    runtime.stop();
    runtime.completeStop();
    runtime.beginPreflight('rehearsal');
    runtime.arm();
    expect(runtime.ingest(sample(30, 2_000)).dueCues.map((due) => due.cue.id)).toEqual(['cue-1']);
  });

  it('从正在播放的当前 MTC 布防时把过去 Cue 标为错过且不回填', () => {
    const runtime = new CueRuntime(project());
    runtime.selectItem('item');
    runtime.beginPreflight('rehearsal');
    expect(runtime.arm(1_000, sample(35, 1_000))).toMatchObject({ state: 'armed', missedCueIds: ['cue-1'] });
    expect(runtime.ingest(sample(36, 1_034)).dueCues).toEqual([]);
    expect(runtime.ingest(sample(50, 1_500)).dueCues).toEqual([]);
    expect(runtime.ingest(sample(60, 1_834)).dueCues.map((due) => due.cue.id)).toEqual(['cue-2']);
  });
  it('fires crossed cues once and never backfills missed cues', () => {
    const runtime = new CueRuntime(project());
    runtime.selectItem('item');
    runtime.beginPreflight('rehearsal');
    runtime.arm();
    expect(runtime.ingest(sample(28, 0)).dueCues).toHaveLength(0);
    expect(runtime.ingest(sample(30, 67)).dueCues.map((due) => due.cue.id)).toEqual(['cue-1']);
    for (let frame = 32; frame <= 58; frame += 2) {
      expect(runtime.ingest(sample(frame, 67 + ((frame - 30) / 2) * 67)).dueCues).toHaveLength(0);
    }
    expect(runtime.ingest(sample(60, 1072)).dueCues.map((due) => due.cue.id)).toEqual(['cue-2']);
    expect(runtime.ingest(sample(60, 1082)).dueCues).toHaveLength(0);
  });

  it('freezes on loss and requires explicit resync', () => {
    const runtime = new CueRuntime(project());
    runtime.selectItem('item');
    runtime.beginPreflight('rehearsal');
    runtime.arm();
    runtime.ingest(sample(0, 0));
    expect(runtime.tick(501)).toMatchObject({ state: 'timecodeLost', reason: 'MTC 信号中断' });
    expect(runtime.ingest(sample(30, 1000)).dueCues).toHaveLength(0);
    expect(runtime.resync(sample(30, 1000))).toMatchObject({ state: 'running', missedCueIds: ['cue-1'] });
  });

  it('从当前 MTC 布防后不再收到新帧也会在 500ms 后冻结', () => {
    const runtime = new CueRuntime(project());
    runtime.selectItem('item');
    runtime.beginPreflight('live');
    runtime.arm(1_000, sample(35, 1_000));
    expect(runtime.tick(1_501)).toMatchObject({ state: 'timecodeLost', reason: 'MTC 信号中断' });
  });

  it('布防后首个完整 MTC 到达前中断也会在 500ms 后冻结', () => {
    const runtime = new CueRuntime(project());
    runtime.selectItem('item');
    runtime.beginPreflight('rehearsal');
    runtime.arm(0);

    expect(runtime.tick(500).state).toBe('armed');
    expect(runtime.tick(501)).toMatchObject({
      state: 'timecodeLost',
      reason: 'MTC 信号中断',
      dueCues: []
    });
  });

  it('等待 P1 首次播放时保持待命，开始播放后仍在断流 500ms 后冻结', () => {
    const runtime = new CueRuntime(project());
    runtime.selectItem('item');
    runtime.beginPreflight('live');
    runtime.arm(0, null, 'awaiting-external-start');
    expect(runtime.tick(30_000)).toMatchObject({ state: 'armed', dueCues: [] });
    expect(runtime.ingest(sample(0, 30_000))).toMatchObject({ state: 'running', dueCues: [] });
    expect(runtime.ingest(sample(2, 30_067))).toMatchObject({ state: 'running', dueCues: [] });
    expect(runtime.tick(30_568)).toMatchObject({ state: 'timecodeLost', reason: 'MTC 信号中断' });
    expect(runtime.ingest(sample(30, 31_000)).dueCues).toEqual([]);
  });

  it('外部播放待命仍拒绝从曲目中途接入', () => {
    const runtime = new CueRuntime(project());
    runtime.selectItem('item');
    runtime.beginPreflight('live');
    runtime.arm(0, null, 'awaiting-external-start');
    expect(runtime.ingest(sample(61, 30_000))).toMatchObject({
      state: 'timecodeLost', reason: 'MTC 首帧未从节目开头开始', dueCues: []
    });
  });

  it('从头布防收到明显晚于开头的首帧时冻结且绝不批量回填 Cue', () => {
    const runtime = new CueRuntime(project());
    runtime.selectItem('item');
    runtime.beginPreflight('rehearsal');
    runtime.arm(0);

    expect(runtime.ingest(sample(61, 100))).toMatchObject({
      state: 'timecodeLost',
      reason: 'MTC 首帧未从节目开头开始',
      dueCues: []
    });
  });

  it('blocks mismatched frame rates', () => {
    const runtime = new CueRuntime(project());
    runtime.selectItem('item');
    runtime.beginPreflight('rehearsal');
    runtime.arm();
    expect(runtime.ingest(sample(0, 0, '25'))).toMatchObject({ state: 'error' });
  });

  it('allows manual GO only after takeover confirmation', () => {
    const runtime = new CueRuntime(project());
    runtime.selectItem('item');
    runtime.beginPreflight('rehearsal');
    runtime.arm();
    expect(runtime.manualGo('cue-1')).toMatchObject({ state: 'error' });

    const recovered = new CueRuntime(project());
    recovered.selectItem('item');
    recovered.beginPreflight('rehearsal');
    recovered.arm();
    recovered.ingest(sample(0, 0));
    recovered.tick(501);
    recovered.enableManualTakeover();
    expect(recovered.manualGo('cue-1').dueCues.map((due) => due.cue.id)).toEqual(['cue-1']);
    expect(recovered.manualGo('cue-1')).toMatchObject({ state: 'error', reason: 'Cue 已执行：一秒' });
  });

  it('暂停自动联动时持续跟踪 MTC，并将越过的 Cue 标为错过', () => {
    const runtime = new CueRuntime(project());
    runtime.selectItem('item');
    runtime.beginPreflight('rehearsal');
    runtime.arm();
    runtime.ingest(sample(28, 0));
    expect(runtime.pauseAutomatic().state).toBe('paused');
    const paused = runtime.ingest(sample(30, 67));
    expect(paused).toMatchObject({ state: 'paused', missedCueIds: ['cue-1'] });
    expect(runtime.resumeAutomatic().state).toBe('running');
    expect(runtime.ingest(sample(32, 134)).dueCues).toEqual([]);
  });

  it('手动接管拒绝触发已停用 Cue', () => {
    const value = project();
    value.rundown[0]!.cues[0]!.enabled = false;
    const runtime = new CueRuntime(value);
    runtime.selectItem('item');
    runtime.beginPreflight('rehearsal');
    runtime.arm();
    runtime.ingest(sample(0, 0));
    runtime.tick(501);
    runtime.enableManualTakeover();
    expect(runtime.manualGo('cue-1')).toMatchObject({ state: 'error', reason: 'Cue 已停用：一秒' });
  });

  it('手动接管按最后时间码标记丢码期间越过且未执行的 Cue', () => {
    const runtime = new CueRuntime(project());
    runtime.selectItem('item');
    runtime.beginPreflight('rehearsal');
    runtime.arm();
    runtime.ingest(sample(0, 0));
    runtime.tick(501);

    expect(runtime.enableManualTakeover(sample(35, 1_100))).toMatchObject({
      state: 'paused',
      manualTakeover: true,
      missedCueIds: ['cue-1']
    });
    expect(runtime.manualGo('cue-2').dueCues.map((due) => due.cue.id)).toEqual(['cue-2']);
  });

  it('明确经过 stopping 状态后回到 idle', () => {
    const runtime = new CueRuntime(project());
    runtime.selectItem('item');
    expect(runtime.stop()).toMatchObject({ state: 'stopping', reason: '操作员请求停止' });
    expect(runtime.completeStop().state).toBe('idle');
  });

  it('停用节目不能被选为当前节目', () => {
    const value = project();
    const disabled = parseLinkProject({
      ...value,
      rundown: value.rundown.map((item) => ({ ...item, enabled: false }))
    });
    expect(new CueRuntime(disabled).selectItem('item')).toMatchObject({ state: 'error', reason: '节目已停用：节目' });
  });

  it('拒绝绕过 preflight 布防以及在运行中切换节目或重新预检', () => {
    const unprepared = new CueRuntime(project());
    unprepared.selectItem('item');
    expect(unprepared.arm()).toMatchObject({ state: 'error', reason: '只有 preflight 状态可以布防，当前为 idle' });

    const running = new CueRuntime(project());
    running.selectItem('item');
    running.beginPreflight('live');
    running.arm();
    running.ingest(sample(0, 0));
    expect(running.selectItem('item')).toMatchObject({ state: 'running', reason: '运行状态 running 下不能切换节目' });
    expect(running.getState()).toBe('running');

    const armed = new CueRuntime(project());
    armed.selectItem('item');
    armed.beginPreflight('rehearsal');
    armed.arm();
    expect(armed.beginPreflight('live')).toMatchObject({ state: 'error', reason: '运行状态 armed 下不能重新预检' });
  });

  it('P1 播放触发失败时从 armed 明确进入 error', () => {
    const runtime = new CueRuntime(project());
    runtime.selectItem('item');
    runtime.beginPreflight('rehearsal');
    runtime.arm();
    expect(runtime.abortStart('P1 MIDI 发送失败')).toMatchObject({ state: 'error', reason: 'P1 MIDI 发送失败' });
  });

  it('执行链错误会冻结状态机，必须停止清理后才能重新预检', () => {
    const runtime = new CueRuntime(project());
    runtime.selectItem('item');
    runtime.beginPreflight('rehearsal');
    runtime.arm();
    runtime.ingest(sample(0, 0));

    expect(runtime.failExecution('OBS 执行失败')).toMatchObject({ state: 'error', reason: 'OBS 执行失败' });
    expect(runtime.ingest(sample(30, 1_000))).toMatchObject({ state: 'error', dueCues: [] });
    expect(runtime.beginPreflight('rehearsal')).toMatchObject({ state: 'error', reason: '运行状态 error 下不能重新预检' });
    expect(runtime.selectItem('item')).toMatchObject({ state: 'error', reason: '运行状态 error 下不能切换节目' });
    expect(runtime.stop().state).toBe('stopping');
    expect(runtime.completeStop().state).toBe('idle');
    expect(runtime.beginPreflight('rehearsal').state).toBe('preflight');
  });

  it('同一帧的多个 Cue 按节目列表顺序触发', () => {
    const value = project();
    value.rundown[0]!.cues[1]!.timecode = frameNumberToTimecode(30, '30');
    const runtime = new CueRuntime(value);
    runtime.selectItem('item');
    runtime.beginPreflight('rehearsal');
    runtime.arm();

    expect(runtime.ingest(sample(30, 1_000)).dueCues.map((due) => due.cue.id)).toEqual(['cue-1', 'cue-2']);
  });

  it('带持续时间的 OBS 显示 Cue 在结束帧生成明确隐藏动作', () => {
    const value = project();
    value.rundown[0]!.cues = [{
      id: 'camera',
      name: '显示机位',
      timecode: frameNumberToTimecode(30, '30'),
      durationMs: 1_000,
      enabled: true,
      notes: '',
      layerId: 'layer',
      actions: [{ id: 'show', label: '显示机位', kind: 'obs.setSceneItemEnabled', sceneName: '团播联动台输出', sourceName: '机位一', enabled: true }]
    }];
    const runtime = new CueRuntime(value);
    runtime.selectItem('item');
    runtime.beginPreflight('rehearsal');
    runtime.arm();

    const show = runtime.ingest(sample(30, 1_000)).dueCues;
    expect(show.map((due) => due.cue.id)).toEqual(['camera']);
    for (let frame = 32; frame <= 58; frame += 2) runtime.ingest(sample(frame, 1_000 + (frame - 30) / 2 * 67));
    const hide = runtime.ingest(sample(60, 2_005)).dueCues;
    expect(hide.map((due) => due.cue.id)).toEqual(['camera:duration-end']);
    expect(hide[0]?.cue.actions).toEqual([{
      id: 'show:duration-end', label: '隐藏来源 · 机位一', kind: 'obs.setSceneItemEnabled',
      sceneName: '团播联动台输出', sourceName: '机位一', enabled: false
    }]);
  });

  it('MTC 丢失后重同步会把已越过的 OBS 自动结束边界标为错过', () => {
    const value = project();
    value.rundown[0]!.cues = [{
      id: 'camera', name: '显示机位', timecode: frameNumberToTimecode(30, '30'), durationMs: 1_000,
      enabled: true, notes: '', layerId: 'layer', actions: [{
        id: 'show', label: '显示机位', kind: 'obs.setSceneItemEnabled',
        sceneName: '团播联动台输出', sourceName: '机位一', enabled: true
      }]
    }];
    const runtime = new CueRuntime(value);
    runtime.selectItem('item');
    runtime.beginPreflight('rehearsal');
    runtime.arm();
    expect(runtime.ingest(sample(30, 1_000)).dueCues.map((due) => due.cue.id)).toEqual(['camera']);
    expect(runtime.tick(1_501).state).toBe('timecodeLost');

    expect(runtime.resync(sample(60, 1_500))).toMatchObject({
      state: 'running',
      missedCueIds: ['camera:duration-end']
    });
  });

  it('隐藏视觉图层不会把显示 Cue 发送到运行执行队列', () => {
    const value = project();
    value.rundown[0]!.visualLayers[0]!.visible = false;
    value.rundown[0]!.cues = [{
      id: 'camera', name: '显示机位', timecode: frameNumberToTimecode(30, '30'), durationMs: 1_000,
      enabled: true, notes: '', layerId: 'layer', actions: [{
        id: 'show', label: '显示机位', kind: 'obs.setSceneItemEnabled', sceneName: '团播联动台输出', sourceName: '机位一', enabled: true
      }]
    }];
    const runtime = new CueRuntime(value);
    runtime.selectItem('item');
    runtime.beginPreflight('rehearsal');
    runtime.arm();

    expect(runtime.ingest(sample(30, 1_000)).dueCues).toEqual([]);
  });

  it('节目选择时将当前时间以前的 Cue 标为错过且不补触发', () => {
    const runtime = new CueRuntime(project());
    const selected = runtime.selectItem('item', 35);
    expect(selected.missedCueIds).toEqual(['cue-1']);
    runtime.beginPreflight('rehearsal');
    runtime.arm(0, sample(35, 0));
    expect(runtime.ingest(sample(36, 34)).dueCues).toEqual([]);
  });

  it('P1 暂停后同位置恢复继续过点，跳到中途则拒绝恢复', () => {
    const runtime = new CueRuntime(project());
    runtime.selectItem('item'); runtime.beginPreflight('live'); runtime.arm();
    runtime.ingest(sample(28, 0));
    expect(runtime.tick(600).state).toBe('timecodeLost');
    expect(runtime.resumeP1(sample(30, 5000))).toMatchObject({ state: 'running', dueCues: [{ cue: { id: 'cue-1' } }] });
    expect(runtime.tick(5600).state).toBe('timecodeLost');
    expect(runtime.resumeP1(sample(90, 9000)).state).toBe('error');
  });

  it('非预期前跳和时间倒退都立即进入 timecodeLost', () => {
    const jump = new CueRuntime(project());
    jump.selectItem('item');
    jump.beginPreflight('rehearsal');
    jump.arm();
    jump.ingest(sample(0, 0));
    expect(jump.ingest(sample(60, 67))).toMatchObject({ state: 'timecodeLost', reason: 'MTC 时间跳变' });

    const backwards = new CueRuntime(project());
    backwards.selectItem('item');
    backwards.beginPreflight('rehearsal');
    backwards.arm();
    backwards.ingest(sample(30, 0));
    expect(backwards.ingest(sample(0, 67))).toMatchObject({ state: 'timecodeLost', reason: 'MTC 时间倒退' });
  });
});

function project(): LinkProject {
  return parseLinkProject({
    schemaVersion: 1,
    projectId: 'project',
    name: '测试工程',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    timebase: { frameRate: '30', mode: 'per-item-reset' },
    rundown: [{
      id: 'item',
      title: '节目',
      notes: '',
      visualLayers: [{ id: 'layer', name: '图层 1', visible: true, locked: false }],
      cues: [
        { id: 'cue-1', name: '一秒', timecode: frameNumberToTimecode(30, '30'), enabled: true, notes: '', actions: [] },
        { id: 'cue-2', name: '两秒', timecode: frameNumberToTimecode(60, '30'), enabled: true, notes: '', actions: [] }
      ]
    }]
  });
}

function sample(totalFrames: number, receivedAtMs: number, frameRate: MtcFrameRate = '30'): MtcSample {
  return {
    frameRate,
    timecode: frameNumberToTimecode(totalFrames, frameRate),
    totalFrames,
    receivedAtMs,
    direction: 'forward'
  };
}
