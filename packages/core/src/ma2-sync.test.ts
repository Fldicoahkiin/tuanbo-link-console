import { describe, expect, it } from 'vitest';
import { ma2SyncSnapshotSchema, type Ma2SyncObject, type Ma2SyncSnapshot } from '@tb/schema';
import { previewMa2Sync, resolveMa2Sync, sameMa2Content } from './ma2-sync';
import { Ma2SyncSession, type Ma2SyncPort } from './ma2-sync-session';

function event(id: string, time = '1000'): Ma2SyncObject {
  return { id, kind: 'event', parentId: null, order: 0, properties: { time, cue: '1.5', name: '主歌' } };
}
function snapshot(objects: Ma2SyncObject[], revision = 'r1'): Ma2SyncSnapshot {
  return { bindingId: 'test-binding', consoleVersion: 'test-only', revision, objects };
}
function fixture() {
  const base = snapshot([event('a')]);
  const local = snapshot([event('a', '2000')]);
  const calls: string[] = [];
  let remote = structuredClone(base);
  const port: Ma2SyncPort = {
    read: () => { calls.push('read'); return Promise.resolve(structuredClone(remote)); },
    backup: (current) => { calls.push('backup'); return Promise.resolve({ backupId: 'backup-1', revision: current.revision }); },
    apply: (desired, revision) => {
      calls.push('write');
      if (remote.revision !== revision) return Promise.reject(new Error('revision changed'));
      remote = { ...structuredClone(desired), revision: 'r2' };
      return Promise.resolve();
    }
  };
  return { base, local, calls, port, preview: previewMa2Sync(base, local, remote) };
}

describe('MA2 三方差异', () => {
  it('轨道单侧排序与另一侧静音可合并，双方不同排序仍需确认', () => {
    const track = (id: string, order: number): Ma2SyncObject => ({ id, kind: 'track', parentId: null, order, properties: { name: id, muted: 'false' } });
    const base = snapshot([track('a', 0), track('b', 1)]);
    const local = snapshot([track('a', 1), track('b', 0)]);
    const remote = snapshot([{ ...track('a', 0), properties: { name: '控台改名', muted: 'true' } }, track('b', 1)]);
    const merged = previewMa2Sync(base, local, remote);
    expect(merged.conflicts).toEqual([]);
    expect(resolveMa2Sync(merged, new Map()).objects.find((object) => object.id === 'a')).toMatchObject({ order: 1, properties: { name: '控台改名', muted: 'true' } });
    const competing = snapshot([{ ...remote.objects[0]!, order: 2 }, remote.objects[1]!]);
    expect(previewMa2Sync(base, local, competing).conflicts.map((conflict) => conflict.id)).toEqual(['a']);
    const sameOrder = snapshot([{ ...remote.objects[0]!, order: 1 }, { ...remote.objects[1]!, order: 0 }]);
    expect(previewMa2Sync(base, local, sameOrder).conflicts).toEqual([]);
  });
  it('同一事件分别修改时间与名称时自动合并，双方输入保持不变', () => {
    const base = snapshot([event('a')]);
    const local = snapshot([event('a', '2000')]);
    const remote = snapshot([{ ...event('a'), properties: { ...event('a').properties, name: '副歌' } }]);
    const before = structuredClone([base, local, remote]);
    const preview = previewMa2Sync(base, local, remote);
    expect(preview.conflicts).toEqual([]);
    expect(resolveMa2Sync(preview, new Map()).objects[0]?.properties).toEqual({ time: '2000', cue: '1.5', name: '副歌' });
    expect([base, local, remote]).toEqual(before);
  });
  it('属性删除、空字符串和新增字段分别合并，未知字段不丢失', () => {
    const base = snapshot([{ ...event('a'), properties: { time: '1000', name: '主歌', remove: 'old', future: '保留' } }]);
    const local = snapshot([{ ...event('a'), properties: { time: '1000', name: '', future: '保留', localOnly: 'A' } }]);
    const remote = snapshot([{ ...event('a'), properties: { ...base.objects[0]!.properties, time: '2000', remoteOnly: 'B' } }]);
    expect(resolveMa2Sync(previewMa2Sync(base, local, remote), new Map()).objects[0]?.properties).toEqual({ time: '2000', name: '', future: '保留', localOnly: 'A', remoteOnly: 'B' });
    const conflicting = snapshot([{ ...event('a'), properties: { ...remote.objects[0]!.properties, remove: 'changed' } }]);
    expect(previewMa2Sync(base, local, conflicting).conflicts).toHaveLength(1);
  });
  it('对象类型或层序变化不与属性编辑盲目组合', () => {
    const base = snapshot([event('a')]);
    for (const changed of [{ ...event('a'), order: 1 }, { ...event('a'), kind: 'track' as const }]) {
      expect(previewMa2Sync(base, snapshot([changed]), snapshot([event('a', '2000')])).conflicts).toHaveLength(1);
    }
  });
  it('合并双方各自修改的不同事件', () => {
    const base = snapshot([event('a'), event('b')]);
    const preview = previewMa2Sync(base, snapshot([event('a', '2000'), event('b')]), snapshot([event('a'), event('b', '3000')]));
    expect(preview.conflicts).toEqual([]);
    const result = resolveMa2Sync(preview, new Map());
    expect(result.objects.map((entry) => entry.properties.time)).toEqual(['2000', '3000']);
  });
  it('同一事件两边不同修改必须选择版本', () => {
    const preview = previewMa2Sync(snapshot([event('a')]), snapshot([event('a', '2000')]), snapshot([event('a', '3000')]));
    expect(preview.conflicts).toHaveLength(1);
    expect(() => resolveMa2Sync(preview, new Map())).toThrow('冲突');
    expect(resolveMa2Sync(preview, new Map([['a', 'remote']])).objects[0]?.properties.time).toBe('3000');
  });
  it('删除与修改冲突保留明确删除选项', () => {
    const preview = previewMa2Sync(snapshot([event('a')]), snapshot([]), snapshot([event('a', '2000')]));
    expect(preview.conflicts[0]?.local).toBeNull();
    expect(resolveMa2Sync(preview, new Map([['a', 'local']])).objects).toEqual([]);
  });
  it('单侧删除与双方相同新增不会产生冲突', () => {
    const preview = previewMa2Sync(snapshot([event('a')]), snapshot([event('b')]), snapshot([event('a'), event('b')]));
    expect(resolveMa2Sync(preview, new Map()).objects.map((entry) => entry.id)).toEqual(['b']);
  });
  it('名称和 Cue 编号变化不会改变同步身份', () => {
    const base = snapshot([event('stable')]);
    const changed = { ...event('stable'), properties: { time: '1000', cue: '12', name: '副歌' } };
    expect(resolveMa2Sync(previewMa2Sync(base, base, snapshot([changed])), new Map()).objects).toEqual([changed]);
  });
  it('忽略属性枚举顺序，保留未知字段并校验内容', () => {
    const left = snapshot([{ ...event('a'), properties: { alpha: '1', future: '未知数据' } }]);
    const right = snapshot([{ ...event('a'), properties: { future: '未知数据', alpha: '1' } }], 'r2');
    expect(sameMa2Content(left, right)).toBe(true);
    expect(sameMa2Content(left, snapshot([event('a')]))).toBe(false);
  });
  it('拒绝跨绑定与跨软件版本同步', () => {
    const base = snapshot([]);
    expect(() => previewMa2Sync(base, base, { ...base, bindingId: 'other' })).toThrow('绑定');
    expect(() => previewMa2Sync(base, base, { ...base, consoleVersion: 'other' })).toThrow('版本');
  });
  it('拒绝重复 ID、悬空父级、循环及未声明快照字段', () => {
    expect(ma2SyncSnapshotSchema.safeParse(snapshot([event('a'), event('a')])).success).toBe(false);
    expect(ma2SyncSnapshotSchema.safeParse(snapshot([{ ...event('a'), parentId: 'missing' }])).success).toBe(false);
    expect(ma2SyncSnapshotSchema.safeParse(snapshot([{ ...event('a'), parentId: 'b' }, { ...event('b'), parentId: 'a' }])).success).toBe(false);
    expect(ma2SyncSnapshotSchema.safeParse({ ...snapshot([]), ignored: 'must not drop' }).success).toBe(false);
  });
  it('合并后不允许子对象引用已删除父级', () => {
    const parent = { ...event('parent'), kind: 'track' as const };
    const base = snapshot([parent]);
    const remote = snapshot([parent, { ...event('child'), parentId: 'parent' }]);
    expect(() => resolveMa2Sync(previewMa2Sync(base, snapshot([]), remote), new Map())).toThrow('父级');
  });
});

describe('MA2 同步事务（模拟端口，不代表控台验收）', () => {
  it('先备份，再写入，回读一致后才更新基线', async () => {
    const f = fixture();
    const result = await new Ma2SyncSession(f.port, () => false).apply(f.preview, new Map());
    expect(f.calls).toEqual(['read', 'backup', 'write', 'read']);
    expect(result).toMatchObject({ status: 'verified', backupId: 'backup-1', baseline: { revision: 'r2' } });
  });
  it('播放中不访问控台', async () => {
    const f = fixture();
    expect(await new Ma2SyncSession(f.port, () => true).apply(f.preview, new Map())).toMatchObject({ status: 'incomplete', mayHaveWritten: false });
    expect(f.calls).toEqual([]);
  });
  it('备份期间开始播放则阻止写入', async () => {
    const f = fixture();
    let playing = false;
    f.port.backup = () => { playing = true; return Promise.resolve({ backupId: 'backup-1', revision: 'r1' }); };
    expect(await new Ma2SyncSession(f.port, () => playing).apply(f.preview, new Map())).toMatchObject({ status: 'incomplete', backupId: 'backup-1', mayHaveWritten: false });
    expect(f.calls).not.toContain('write');
  });
  it('预览后控台发生修改则要求重新预览', async () => {
    const f = fixture();
    f.port.read = () => Promise.resolve(snapshot([event('a', '9999')], 'r3'));
    expect(await new Ma2SyncSession(f.port, () => false).apply(f.preview, new Map())).toMatchObject({ status: 'incomplete', stage: 'read', mayHaveWritten: false });
    expect(f.calls).toEqual([]);
  });
  it('备份失败不得写入', async () => {
    const f = fixture();
    f.port.backup = () => Promise.reject(new Error('磁盘已满'));
    expect(await new Ma2SyncSession(f.port, () => false).apply(f.preview, new Map())).toMatchObject({ status: 'incomplete', stage: 'backup', message: '磁盘已满', mayHaveWritten: false });
    expect(f.calls).not.toContain('write');
  });
  it('写入超时保留备份且不自动重试', async () => {
    const f = fixture();
    f.port.apply = () => { f.calls.push('write'); return Promise.reject(new Error('超时')); };
    expect(await new Ma2SyncSession(f.port, () => false).apply(f.preview, new Map())).toMatchObject({ status: 'incomplete', stage: 'write', backupId: 'backup-1', mayHaveWritten: true });
    expect(f.calls.filter((call) => call === 'write')).toHaveLength(1);
  });
  it('控台接受请求但未应用数据不得显示成功', async () => {
    const f = fixture();
    f.port.apply = () => Promise.resolve();
    expect(await new Ma2SyncSession(f.port, () => false).apply(f.preview, new Map())).toMatchObject({ status: 'incomplete', stage: 'verify', mayHaveWritten: true });
  });
  it('相同内容只读取，不做无意义写入', async () => {
    const f = fixture();
    const preview = previewMa2Sync(f.base, f.base, f.base);
    expect(await new Ma2SyncSession(f.port, () => false).apply(preview, new Map())).toMatchObject({ status: 'verified', backupId: null });
    expect(f.calls).toEqual(['read']);
  });
  it('同一个会话拒绝并发同步并在完成后释放锁', async () => {
    const f = fixture();
    let unblock: (value: unknown) => void = () => { throw new Error('读取尚未开始'); };
    f.port.read = () => new Promise<unknown>((resolve) => { unblock = resolve; });
    const session = new Ma2SyncSession(f.port, () => false);
    const preview = previewMa2Sync(f.base, f.base, f.base);
    const first = session.apply(preview, new Map());
    expect(session.isBusy).toBe(true);
    expect(await session.apply(preview, new Map())).toMatchObject({ status: 'incomplete', stage: 'preflight' });
    unblock(f.base);
    expect(await first).toMatchObject({ status: 'verified' });
    expect(session.isBusy).toBe(false);
  });
});
