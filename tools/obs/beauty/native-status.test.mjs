import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeStatus } from './native-status.mjs';

const channel = 'Local\\tblink-beauty-1-2';
const line = (time, status, accepted = 5, source = channel) => `${time}: [tblink-beauty] channel=${source} live status=${status} faces=2 profiles=0 accepted=${accepted} age_ms=100`;
const run = lines => nativeStatus([{ name: '2026-10-06 10-00-00.txt', text: lines.join('\n') }], channel,
  '2026-10-06T10:00:00', '2026-10-06T10:00:02');

test('短于界面采样间隔的原生回退仍被记录', () => {
  const result = run([line('10:00:00.100',1), line('10:00:00.200',3), line('10:00:00.233',1)]);
  assert.equal(result.expiredTransitions,1);
  assert.equal(result.transitions.length,3);
});
test('启动前、结束后和其他来源的回退不混入目标窗口', () => {
  const result = run([line('10:00:00.000',3,0), line('10:00:00.100',1),
    line('10:00:00.200',3,5,'Local\\tblink-beauty-9-9'), line('10:00:02.100',3)]);
  assert.equal(result.expiredTransitions,0);
  assert.equal(result.transitions.length,1);
});
test('进入观测窗口前已接受的来源仍检查窗口内回退', () => {
  assert.equal(run([line('09:59:59.900',1),line('10:00:00.010',3)]).expiredTransitions,1);
});

test('窗口开始前发生且持续到窗口中的过期不能漏报', () => {
  const result = run([line('09:59:59.800',1),line('09:59:59.900',3),line('10:00:00.100',1)]);
  assert.equal(result.expiredAtStart,true);
  assert.equal(result.expiredTransitions,1);
});
test('跨午夜日志保留正确日期', () => {
  const result = nativeStatus([{ name:'2026-10-06 23-59-59.txt',text:[line('23:59:59.900',1),line('00:00:00.100',3)].join('\n') }],
    channel,'2026-10-06T23:59:59','2026-10-07T00:00:01');
  assert.equal(result.expiredTransitions,1);
  assert.equal(result.transitions[1].at,new Date('2026-10-07T00:00:00.100').getTime());
});
test('没有原生接受证据不能算通过', () => {
  assert.throws(() => run([line('10:00:00.000',3,0)]), /No native accepted/);
});

test('未禁用OBS重复日志过滤时不宣称完整记录', () => {
  assert.equal(run([line('10:00:00.100',1)]).complete,false);
});

test('完整日志参数存在且没有折叠行才可完整验收', () => {
  const header = '09:59:59.000: Command Line Arguments: --portable --unfiltered_log --multi';
  assert.equal(run([header,line('10:00:00.100',1)]).complete,true);
  const suppressed = run([header,line('10:00:00.100',1),'10:00:01.000: Last log entry repeated for 19 more lines']);
  assert.equal(suppressed.complete,false);
  assert.equal(suppressed.suppressedLines,19);
});
