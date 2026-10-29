import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jobVerdict, waitForJob } from './wait-for-job.mjs';

const job = (status, conclusion, run_attempt = 1, name = 'verify') => ({ name, status, conclusion, run_attempt });

test('作业通过才算数；没结束就等；失败、取消或被跳过都不放进草稿', () => {
  assert.deepEqual(jobVerdict([job('completed', 'success'), job('in_progress', null, 1, 'build')], 'verify'), { done: true, ok: true, message: 'verify 作业已通过' });
  assert.equal(jobVerdict([job('in_progress', null)], 'verify').done, false);
  assert.equal(jobVerdict([job('queued', null)], 'verify').done, false);
  assert.equal(jobVerdict([], 'verify').done, false);
  for (const conclusion of ['failure', 'cancelled', 'skipped']) {
    assert.deepEqual(jobVerdict([job('completed', conclusion)], 'verify'), { done: true, ok: false, message: `verify 作业没有通过（${conclusion}），不放进草稿` });
  }
});

test('同一作业有几次运行时看最新的一次', () => {
  assert.equal(jobVerdict([job('completed', 'failure', 1), job('completed', 'success', 2)], 'verify').ok, true);
  assert.equal(jobVerdict([job('completed', 'success', 2), job('completed', 'failure', 3)], 'verify').ok, false);
});

test('轮询到通过为止；失败立即报错；超时报错', async () => {
  const states = [[job('in_progress', null)], [job('in_progress', null)], [job('completed', 'success')]];
  const sleeps = [];
  await waitForJob('verify', { listJobs: async () => states.shift(), sleep: async ms => { sleeps.push(ms); }, pollMs: 5, log: () => {} });
  assert.deepEqual(sleeps, [5, 5]);

  await assert.rejects(waitForJob('verify', { listJobs: async () => [job('completed', 'failure')], sleep: async () => {}, log: () => {} }), /没有通过/);

  let clock = 0;
  await assert.rejects(waitForJob('verify', {
    listJobs: async () => [job('in_progress', null)], sleep: async ms => { clock += ms; }, now: () => clock, pollMs: 10, timeoutMs: 30, log: () => {}
  }), /还没结束/);
});
