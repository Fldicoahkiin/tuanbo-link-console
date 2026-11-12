import { describe, expect, it } from 'vitest';
import { p1FollowRequestSchema, p1FollowStateSchema, type P1FollowState } from './p1-follow';

const ownerId = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const request = (command: unknown) => ({ version: 1, ownerId, command });

const standby: P1FollowState = {
  version: 1, phase: 'standby', ownerId, projectId: 'project', mode: 'manual', runMode: 'live', itemId: null, sessionId: null, generation: 0,
  positionMs: null, cause: null, reason: null, input: { portName: 'loopMIDI Port', state: 'open', reason: null }, mtc: null, outputs: { actionMidi: null }
};

describe('P1 跟随的 IPC 契约（0.5.9 P3a）', () => {
  it('收下设计里的每一条命令，外加离开工程时的 close；手动 GO、重试动作和单步测试不在这里（P3d）', () => {
    const start = { kind: 'start', projectPath: 'C:/Shows/show.tblink', sessionId: ownerId, revision: 3, document: '{}', mode: 'auto', runMode: 'live', inputPortName: 'loopMIDI Port', lightingProfile: null };
    const commands = [start, { kind: 'arm', itemId: 'song' }, { kind: 'arm', itemId: null }, { kind: 'resync' }, { kind: 'rearm' }, { kind: 'manualTakeover' },
      { kind: 'stop' }, { kind: 'close' }];
    for (const command of commands) expect(p1FollowRequestSchema.parse(request(command)).command).toEqual(command);
    for (const command of [{ kind: 'manualGo', cueId: 'cue' }, { kind: 'retryAction', cueId: 'cue', actionId: 'action' },
      { kind: 'testAction', action: { id: 'a', label: '机位', kind: 'obs.setProgramScene', sceneName: '机位 1' } }]) {
      expect(p1FollowRequestSchema.safeParse(request(command)).success).toBe(false);
    }
  });

  it('拒绝多出来的字段、空的输入口和不认识的命令', () => {
    for (const command of [{ kind: 'stop', reason: 'x' }, { kind: 'arm' }, { kind: 'pause' },
      { kind: 'start', projectPath: 'a', sessionId: ownerId, revision: 0, document: '{}', mode: 'manual', runMode: 'live', inputPortName: '' },
      { kind: 'start', projectPath: 'a', sessionId: ownerId, revision: 0, document: '', mode: 'manual', runMode: 'live', inputPortName: 'p' }]) {
      expect(p1FollowRequestSchema.safeParse(request(command)).success).toBe(false);
    }
    expect(p1FollowRequestSchema.safeParse({ version: 1, ownerId: 'page', command: { kind: 'stop' } }).success).toBe(false);
  });

  it('状态：只有没跟随时才没有工程和输入口；只有冻结时才有冻结原因', () => {
    expect(p1FollowStateSchema.parse(standby)).toEqual(standby);
    const closed = { ...standby, phase: 'closed', ownerId: null, projectId: null, mode: null, runMode: null, input: null };
    expect(p1FollowStateSchema.parse(closed)).toEqual(closed);
    expect(p1FollowStateSchema.safeParse({ ...standby, phase: 'closed' }).success).toBe(false);
    expect(p1FollowStateSchema.safeParse({ ...closed, phase: 'standby' }).success).toBe(false);
    expect(p1FollowStateSchema.safeParse({ ...standby, phase: 'frozen' }).success).toBe(false);
    expect(p1FollowStateSchema.safeParse({ ...standby, cause: 'lost' }).success).toBe(false);
    const frozen = { ...standby, phase: 'frozen', itemId: 'song', sessionId: 's', generation: 2, positionMs: 1200, cause: 'jump', reason: 'MTC 时间跳变',
      mtc: { timecode: { hours: 1, minutes: 0, seconds: 1, frames: 6 }, frameRate: '30', receiving: true, stable: false } };
    expect(p1FollowStateSchema.parse(frozen)).toEqual(frozen);
    expect(p1FollowStateSchema.safeParse({ ...frozen, positionMs: -1 }).success).toBe(false);
  });

  it('状态带着跟随它的页面和每一路输出自己报的状态（P3f）：没跟随时没有页面', () => {
    expect(p1FollowStateSchema.safeParse({ ...standby, ownerId: null }).success).toBe(false);
    const closed = { ...standby, phase: 'closed', ownerId: null, projectId: null, mode: null, runMode: null, input: null };
    expect(p1FollowStateSchema.safeParse({ ...closed, ownerId }).success).toBe(false);
    const red = { ...standby, phase: 'running', itemId: 'song', sessionId: 's', generation: 1, positionMs: 100,
      outputs: { actionMidi: { itemId: 'song', state: 'running', reason: null, fault: 'MIDI 动作晚了超过 100 ms，没有补发：开场' } } };
    expect(p1FollowStateSchema.parse(red)).toEqual(red);
    expect(p1FollowStateSchema.safeParse({ ...red, outputs: { actionMidi: { ...red.outputs.actionMidi, state: 'fine' } } }).success).toBe(false);
    expect(p1FollowStateSchema.safeParse({ ...red, outputs: {} }).success).toBe(false);
  });
});
