import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export async function verifySemantic({ root, work, directory, fixture, packet, call, screenshot, difference }) {
  const sourceName = 'Semantic mask diagnostic', filterName = 'Semantic probe';
  await call('CreateInput', { sceneName: 'Beauty', inputName: sourceName, inputKind: 'image_source', inputSettings: { file: fixture, unload: false }, sceneItemEnabled: true });
  const original = await screenshot('semantic-original', sourceName);
  await call('CreateSourceFilter', { sourceName, filterName, filterKind: 'tblink_beauty_prototype', filterSettings: { live_mode: true, uniform_controls: true, smooth: .8, white: .8, slim: 0, eye: 0, lipstick: .8, blush: .8 } });
  const { filterSettings } = await call('GetSourceFilter', { sourceName, filterName });
  assert.equal(filterSettings.transport_version, 7);
  const regions = join(directory, 'semantic-regions.json');
  await writeFile(regions, JSON.stringify(packet));
  const child = spawn(join(work, 'python/Scripts/python.exe'), [join(root, 'tools/obs/beauty/semantic-fixture.py'), '--channel', filterSettings.transport_name, '--regions', regions], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', failure = null, completed = false;
  const acknowledgements = new Set();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try { acknowledgements.add(JSON.parse(line).mode); }
    catch (error) { failure = error; }
  });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const exit = new Promise(resolve => {
    child.once('error', error => { failure = error; completed = true; resolve(null); });
    child.once('exit', code => { completed = true; resolve(code); });
  });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function capture(mode) {
    acknowledgements.delete(mode);
    child.stdin.write(`${mode}\n`);
    const deadline = Date.now() + 5000;
    while (!acknowledgements.has(mode)) {
      if (failure) throw failure;
      assert(!completed, `Diagnostic producer exited: ${stderr}`);
      assert(Date.now() < deadline, `Native mask acknowledgement timed out: ${mode}; ${stderr}`);
      await sleep(10);
    }
    return screenshot(`semantic-${mode}`, sourceName);
  }
  try {
    const absent = await capture('absent');
    const changed = difference(original, absent);
    assert(changed > .1, 'Diagnostic did not exercise skin/makeup effects');
    assert.deepEqual((await capture('zero')).data, original.data, 'Excluded pixels were changed by skin/makeup');
    const half = await capture('half');
    const protectedHalf = difference(original, half, x => x < .45);
    const activeHalf = difference(original, half, x => x > .55);
    assert.equal(protectedHalf, 0, 'Excluded half of the image was changed');
    assert(activeHalf > .1, 'Allowed half of the image did not receive effects');
    assert.deepEqual((await capture('full')).data, absent.data, 'Full mask differs from unmasked effects');
    assert.deepEqual((await capture('absent')).data, absent.data, 'Removing mask retained previous semantic state');
    const profile = await capture('profile-full');
    const profileDifference = difference(original, profile);
    assert(profileDifference > .1, 'Profile skin path did not change pixels without a mesh');
    await call('SetSourceFilterSettings', { sourceName, filterName, filterSettings: { slim: .8, eye: .8, nose: .8, bodySlim: .8 } });
    assert.deepEqual((await capture('profile-full')).data, profile.data, 'Meshless profile changed geometry');
    const profileHalf = await capture('profile-half');
    assert.equal(difference(original, profileHalf, x => x < .45), 0, 'Profile guard leaked outside allowed pixels');
    assert(difference(original, profileHalf, x => x > .55) > .1, 'Profile guard blocked allowed pixels');
    assert.deepEqual((await capture('profile-zero')).data, original.data, 'Zero profile guard changed pixels');
    assert.deepEqual((await capture('profile-none')).data, original.data, 'Removed profile guard persisted');
    await call('SetSourceFilterSettings', { sourceName, filterName, filterSettings: { smooth: 0, white: 0 } });
    assert.deepEqual((await capture('profile-full')).data, original.data, 'Zero profile skin controls changed pixels');
    await call('SetSourceFilterSettings', { sourceName, filterName, filterSettings: { smooth: .8, white: .8 } });
    await capture('profile-full');
    child.stdin.end();
    assert.equal(await exit, 0, stderr);
    await sleep(300);
    assert.deepEqual((await screenshot('semantic-expired', sourceName)).data, original.data, 'Expired result retained effects');
    return { passed: true, scope: 'Deterministic native photometric mask gating; not segmentation quality', changed, protectedHalf, activeHalf, profileDifference };
  } finally {
    child.stdin.end();
    let timer;
    try { await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Diagnostic producer did not stop; retained')), 5000); })]); }
    finally { clearTimeout(timer); lines.close(); await writeFile(join(directory, 'semantic-fixture-stderr.txt'), stderr); }
  }
}
