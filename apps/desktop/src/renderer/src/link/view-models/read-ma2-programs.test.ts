import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type Ma2TimecodePreview } from '@tb/schema';
import { readMa2Programs } from './read-ma2-programs';

it('一条不支持的时间线不会阻断其他完整时间线，失败原因与读取进度可见', async () => {
  const project = createEmptyLinkProject('测试');
  project.rundown = ['a', 'b'].map(id => ({ id, title: id, notes: '', enabled: true, cues: [], referenceMediaClips: [], visualLayers: [] }));
  const preview = (target: number): Ma2TimecodePreview => ({ target, name: 'test', document: createLightingDocument(), sourceXml: '<MA/>', readAt: new Date().toISOString(), mappings: [], warnings: [], unconverted: target === 1 ? [{ path: 'event', reason: '不支持的动作' }] : [] });
  const progress = vi.fn();
  const result = await readMa2Programs(project, [['1', 'a'], ['2', 'b']], target => Promise.resolve(preview(target)), () => undefined, progress);
  expect(result.selections.map(entry => entry.preview.target)).toEqual([1, 2]);
  expect(result.failures).toHaveLength(0);
  const failed = await readMa2Programs(project, [['1', 'a'], ['2', 'b']], target => target === 1 ? Promise.reject(new Error('读取超时')) : Promise.resolve(preview(target)), () => undefined, progress);
  expect(failed.failures).toEqual([{ target: 1, message: '读取超时' }]);
  expect(failed.selections).toHaveLength(1);
  expect(project.rundown.every(item => !item.lighting)).toBe(true);
  expect(progress.mock.calls[0]?.[1]).toContain('Timecode 1 → a');
  await expect(readMa2Programs(project, [['2', 'b']], target => Promise.resolve(preview(target)), () => { throw new Error('已取消'); }, progress)).rejects.toThrow('已取消');
});
