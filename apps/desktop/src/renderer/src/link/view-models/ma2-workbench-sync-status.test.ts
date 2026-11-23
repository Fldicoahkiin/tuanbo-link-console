import { describe, expect, it } from 'vitest';
import { ma2WorkbenchSyncStatus } from './ma2-workbench-sync-status';

type Input = Parameters<typeof ma2WorkbenchSyncStatus>[0];
const ready: Input = { selected: true, target: true, connection: 'connected', session: { status: 'ready', message: '' }, requested: false, changed: false, wait: null, recoveryError: null };
const label = (input: Partial<Input>) => ma2WorkbenchSyncStatus({ ...ready, ...input }).label;

describe('当前节目同步状态', () => {
  it('没有确认依据时交代当前缺少什么', () => {
    expect(label({ selected: false })).toBe('未选择节目');
    expect(label({ target: false })).toBe('未关联控台时间线');
    expect(label({})).toBe('尚未核对');
    expect(label({ changed: true })).toBe('有待同步的修改');
  });
  it('区分核对、等待控台和已经发出的写入', () => {
    expect(label({ requested: true })).toBe('正在核对控台');
    expect(label({ requested: true, wait: '节目停止后继续' })).toBe('节目停止后继续');
    expect(label({ requested: true, session: { status: 'waiting', message: '等待读取通道' } })).toBe('等待读取通道');
    expect(label({ requested: true, song: { state: 'syncing', writing: true } })).toBe('正在写入控台');
    expect(label({ song: { state: 'verified', checkedAt: 100, checking: true } })).toBe('正在核对控台');
  });
  it('控台读回后才显示已同步，变更、断线、失败或待复核时撤下确认', () => {
    const song = { state: 'verified' as const, checkedAt: 100 };
    expect(label({ song: { state: 'verified' } })).toBe('尚未核对');
    expect(label({ song })).toBe('已同步');
    expect(label({ song: { ...song, playbackClockNote: 'Timecode 3 使用 TC Slot 1' } })).toBe('编排已同步 · 核对时码槽');
    expect(label({ song: { ...song, checkedConnection: 1 }, connectionId: 3 })).toBe('尚未核对');
    expect(label({ song: { ...song, checkedConnection: 3 }, connectionId: 3 })).toBe('已同步');
    expect(label({ song, changed: true })).toBe('有待同步的修改');
    expect(label({ song, connection: 'disconnected' })).toBe('等待连接控台');
    expect(label({ song, connection: 'connecting' })).toBe('正在连接控台');
    expect(label({ song, connection: 'authenticating' })).toBe('正在登录控台');
    expect(label({ song: { ...song, waitingForConnection: true } })).toBe('尚未核对');
    expect(label({ song: { state: 'pending', waitingForConnection: true }, changed: true })).toBe('有待同步的修改');
    expect(label({ song, connection: 'unknown' })).toBe('尚未核对');
    expect(label({ song: { ...song, needsSourceCheck: true } })).toBe('尚未核对');
    expect(label({ song: { ...song, recheckRevision: 1 } })).toBe('尚未核对');
    expect(label({ song: { state: 'paused' } })).toBe('同步已暂停');
    expect(label({ song: { state: 'blocked' } })).toBe('同步需要处理');
    expect(label({ song, recoveryError: '工程无法保存' })).toBe('同步需要处理');
  });
});
