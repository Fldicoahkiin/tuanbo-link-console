import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseOf } from './github-releases.mjs';

test('按标签找 release：草稿和正式都算，同一标签有两个就报错', () => {
  const draft = { id: 1, tag_name: 'v0.5.1', draft: true };
  const other = { id: 2, tag_name: 'v0.5.0', draft: false };
  assert.equal(releaseOf([other, draft], 'v0.5.1'), draft);
  assert.equal(releaseOf([other], 'v0.5.1'), null);
  assert.throws(() => releaseOf([draft, { id: 3, tag_name: 'v0.5.1', draft: false }], 'v0.5.1'), /2 个 release/);
});
