import { expect, it, vi } from 'vitest';
import type { Ma2FirstTrackRequest } from '@tb/schema';
import { addMa2FirstTrackCues } from './ma2-first-track-cues';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';

it('重复引用第一轨同一 Cue 只在控台核对一次，两次复制、两个空点各自保留', async () => {
  const direct = { sequence: 1, cue: '8.000' };
  const other = { sequence: 2, cue: '1' };
  const points = [[direct], [other], [], [{ ...direct, cue: '8' }], [other], [], [{ ...direct, includeTracking: false }]];
  const input: Ma2FirstTrackRequest = { projectId: 'p', itemId: 'song', timecode: 3, executor: '1.101', expectedSequence: 1,
    dataDirectory: '', expectedSource: { show: 'test', generation: '1', version: '3.7' }, points: points.map((sources, i) => ({ id: String(i), sources })) };
  const receipt = { sequence: 1, executor: input.executor, backupFile: null, cues: ['8', '9', '10', '11', '12', '13'] };
  const request = vi.fn<Ma2OnpcBridge['request']>().mockResolvedValue(JSON.stringify(receipt));
  const result = await addMa2FirstTrackCues({ request }, input);
  const rows = request.mock.calls[0]![2]!.split('\n').slice(5);
  expect(rows).toHaveLength(6);
  expect(new Set(rows.map(row => row.split(' ')[0])).size).toBe(6);
  expect(result.cues).toEqual(['8', '9', '10', '8', '11', '12', '13']);
  request.mockResolvedValueOnce(JSON.stringify({ ...receipt, cues: ['7', ...receipt.cues.slice(1)] }));
  await expect(addMa2FirstTrackCues({ request }, input)).rejects.toThrow('Cue 编号');
});
