import assert from 'node:assert/strict';

export async function verifyMakeup({ call, screenshot, sourceName, filterName }) {
  const neutral = { brow: 0, eyeliner: 0, blush: 0 };
  const original = await screenshot('makeup-original', sourceName);
  const report = {};
  for (const key of Object.keys(neutral)) {
    await call('SetSourceFilterSettings', { sourceName, filterName, filterSettings: { ...neutral, [key]: 1 } });
    const painted = await screenshot(`makeup-${key}`, sourceName);
    let changed = 0, protectedPixels = 0;
    for (let y = 0; y < 800; y++) for (let x = 0; x < 800; x++) {
      const u = x / 800, v = y / 800, offset = (y * 800 + x) * 4;
      const delta = [0, 1, 2].reduce((sum, channel) => sum + Math.abs(original.data[offset + channel] - painted.data[offset + channel]), 0);
      changed += delta;
      assert.equal(painted.data[offset + 3], original.data[offset + 3], `${key} changed alpha`);
      const eye = (Math.abs(u - .4) < .01 || Math.abs(u - .6) < .01) && Math.abs(v - .4) < .008;
      const mouth = Math.abs(u - .5) < .02 && Math.abs(v - .66) < .004;
      const background = ((u - .5) / .4) ** 2 + ((v - .5) / .4) ** 2 > 1.05;
      if (eye || mouth || background) {
        protectedPixels++; assert.equal(delta, 0, `${key} changed protected eye/mouth/background pixels`);
      }
    }
    assert(changed > 0 && protectedPixels > 0, `${key} did not exercise painted and protected regions`);
    report[key] = { changed, protectedPixels };
  }
  await call('SetSourceFilterSettings', { sourceName, filterName, filterSettings: neutral });
  assert.deepEqual((await screenshot('makeup-reset', sourceName)).data, original.data, 'Makeup reset did not restore image');
  return report;
}
