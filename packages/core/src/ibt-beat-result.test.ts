import { expect, it } from 'vitest';
import { parseIbtBeats } from './ibt-beat-result';

it('保留 IBT 的偏移与非等距节拍，分层不重新生成时间', () => {
  expect(parseIbtBeats('0.063\r\n0.562 120.24\r\n1.064 119.52\r\n1.566\r\n2.070\r\n', 3000)).toEqual({ dense: [63, 562, 1064, 1566, 2070], standard: [63, 1064, 2070], sparse: [63, 2070] });
  expect(parseIbtBeats('', 3000).dense).toEqual([]);
});

it('拒绝损坏、乱序、重复和越界的外部检测结果', () => {
  for (const content of ['NaN', '-1', '1 120 3', '1\n0.5', '0.5\n0.5', '9', '1e999']) expect(() => parseIbtBeats(content, 3000)).toThrow();
});
