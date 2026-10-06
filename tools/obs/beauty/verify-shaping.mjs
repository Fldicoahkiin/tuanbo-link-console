import assert from 'node:assert/strict';

export async function verifyShaping({ call, target, packet, baseline, screenshot, difference }) {
  const neutral = { nose: 0, noseLength: 0, mouth: 0, eyeDistance: 0, jaw: 0, cheek: 0, chin: 0, forehead: 0 };
  const outside = (x, y) => packet.faces.every(f => ((x - f.cx) / f.rx) ** 2 + ((y - f.cy) / f.ry) ** 2 > 1.05);
  const results = {};
  for (const key of Object.keys(neutral)) {
    let negative = null;
    for (const value of (['nose', 'jaw', 'cheek'].includes(key) ? [1] : [-1, 1])) {
      await call('SetSourceFilterSettings', { ...target, filterSettings: { ...neutral, [key]: value } });
      const image = await screenshot(`shaping-${key}-${value}`);
      const changes = packet.faces.map(face => difference(baseline, image,
        (x, y) => ((x - face.cx) / face.rx) ** 2 + ((y - face.cy) / face.ry) ** 2 < 1));
      assert(changes.every(change => change > .01), `${key} did not affect every detected face`);
      assert.equal(difference(baseline, image, outside), 0, `${key} changed background`);
      results[`${key}:${value}`] = changes;
      if (value === -1) negative = image;
      else if (negative) assert(difference(negative, image) > .01, `${key} signs produced identical pixels`);
    }
  }
  await call('SetSourceFilterSettings', { ...target, filterSettings: neutral });
  assert.equal(difference(baseline, await screenshot('shaping-reset')), 0, 'Shape reset did not restore original');
  await call('SetSourceFilterSettings', { ...target, filterSettings: { lipstick: 1 } });
  const painted = await screenshot('lipstick-two-faces');
  results.lipstick = packet.faces.map(face => difference(baseline, painted,
    (x, y) => ((x - face.cx) / face.rx) ** 2 + ((y - face.cy) / face.ry) ** 2 < 1));
  assert(results.lipstick.every(value => value > .01), 'Lipstick did not affect every detected face');
  assert.equal(difference(baseline, painted, outside), 0, 'Lipstick changed face-exterior pixels');
  await call('SetSourceFilterSettings', { ...target, filterSettings: { lipstick: 0 } });
  for (const key of ['brow', 'eyeliner', 'blush', 'darkCircles', 'nasolabial']) {
    await call('SetSourceFilterSettings', { ...target, filterSettings: { brow: 0, eyeliner: 0, blush: 0, darkCircles: 0, nasolabial: 0, [key]: 1 } });
    const image = await screenshot(`two-faces-${key}`);
    results[key] = packet.faces.map(face => difference(baseline, image,
      (x, y) => ((x - face.cx) / face.rx) ** 2 + ((y - face.cy) / face.ry) ** 2 < 1));
    assert(results[key].every(value => value > .001), `${key} did not affect every detected face`);
    assert.equal(difference(baseline, image, outside), 0, `${key} changed face-exterior pixels`);
  }
  await call('SetSourceFilterSettings', { ...target, filterSettings: { brow: 0, eyeliner: 0, blush: 0, darkCircles: 0, nasolabial: 0 } });
  for (const [strength, tone] of [['lipstick', 'lipstickTone'], ['blush', 'blushTone']]) {
    let cool;
    for (const value of [-1, 1]) {
      await call('SetSourceFilterSettings', { ...target, filterSettings: { [strength]: 1, [tone]: value } });
      const image = await screenshot(`two-faces-${tone}-${value}`);
      assert.equal(difference(baseline, image, outside), 0, `${tone} changed background`);
      if (value === -1) cool = image;
      else {
        results[tone] = packet.faces.map(face => difference(cool, image,
          (x, y) => ((x - face.cx) / face.rx) ** 2 + ((y - face.cy) / face.ry) ** 2 < 1));
        assert(results[tone].every(change => change > .001), `${tone} did not change both faces`);
      }
    }
    await call('SetSourceFilterSettings', { ...target, filterSettings: { [strength]: 0 } });
    assert.equal(difference(baseline, await screenshot(`${tone}-zero-strength`)), 0, `${tone} changed pixels at zero strength`);
    await call('SetSourceFilterSettings', { ...target, filterSettings: { [tone]: 0 } });
  }
  await call('SetSourceFilterSettings', { ...target, filterSettings: { teeth: 1 } });
  const whitened = await screenshot('teeth-two-faces');
  results.teeth = packet.faces.map(face => difference(baseline, whitened,
    (x, y) => ((x - face.cx) / face.rx) ** 2 + ((y - face.cy) / face.ry) ** 2 < 1));
  assert(results.teeth.every(value => value > .001), 'Teeth whitening did not affect both faces');
  assert.equal(difference(baseline, whitened, outside), 0, 'Teeth whitening changed background');
  await call('SetSourceFilterSettings', { ...target, filterSettings: { teeth: 0 } });
  return results;
}
