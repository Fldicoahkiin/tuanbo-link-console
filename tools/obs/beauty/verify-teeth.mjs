import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureMesh } from './fixture-mesh.mjs';

export async function verifyTeeth({ call, screenshot, directory, PNG }) {
  const sourceName = 'Teeth fixture', filterName = 'Teeth probe';
  const image = new PNG({ width: 800, height: 800 });
  const tooth = (u, v) => u > .47 && u < .495 && v > .65 && v < .67;
  for (let y = 0; y < 800; y++) for (let x = 0; x < 800; x++) {
    const u = x / 800, v = y / 800;
    let color = [200, 150, 115, 255];
    if (u > .47 && u < .53 && v > .65 && v < .67) color = tooth(u, v) ? [170, 155, 125, 255] : u < .51 ? [180, 40, 60, 255] : [20, 20, 20, 255];
    if (u > .2 && u < .3 && v > .65 && v < .67) color = [170, 155, 125, 255];
    image.data.set(color, (y * 800 + x) * 4);
  }
  const path = join(directory, 'teeth-markers.png');
  await writeFile(path, PNG.sync.write(image));
  const positions = { 1: [.5, .51], 98: [.46, .52], 327: [.54, .52], 61: [.43, .66], 291: [.57, .66],
    0: [.5, .58], 17: [.5, .74], 13: [.5, .64], 14: [.5, .68], 152: [.5, .85], 10: [.5, .15] };
  const face = { cx: .5, cy: .5, rx: .4, ry: .4, lx: .4, ly: .4, ex: .6, ey: .4, smooth: 0, white: 0, slim: 0, eye: 0,
    ...fixtureMesh(positions, [.5, .5], [.4, .4, .6, .4]) };
  await call('CreateInput', { sceneName: 'Beauty', inputName: sourceName, inputKind: 'image_source', inputSettings: { file: path }, sceneItemEnabled: false });
  await call('CreateSourceFilter', { sourceName, filterName, filterKind: 'tblink_beauty_prototype', filterSettings: { fixture_json: JSON.stringify({ version: 3, mode: 'static-fixture', faces: [face] }) } });
  const baseline = await screenshot('teeth-neutral', sourceName), results = {};
  for (const amount of [.5, 1]) {
    await call('SetSourceFilterSettings', { sourceName, filterName, filterSettings: { teeth: amount } });
    const processed = await screenshot(`teeth-${amount}`, sourceName);
    let lifted = 0, protectedChannels = 0;
    for (let y = 0; y < 800; y++) for (let x = 0; x < 800; x++) for (let c = 0; c < 4; c++) {
      const offset = (y * 800 + x) * 4 + c, delta = processed.data[offset] - baseline.data[offset];
      if (c < 3 && tooth(x / 800, y / 800)) { assert(delta >= 0, 'Teeth pixel darkened'); lifted += delta; }
      else { assert.equal(delta, 0, 'Teeth whitening changed gums, dark mouth, lips, background or alpha'); protectedChannels++; }
    }
    assert(lifted > 0 && protectedChannels > 0);
    results[amount] = { lifted, protectedChannels };
  }
  assert(results[1].lifted > results[.5].lifted);
  await call('SetSourceFilterSettings', { sourceName, filterName, filterSettings: { teeth: 0 } });
  assert.deepEqual((await screenshot('teeth-reset', sourceName)).data, baseline.data);
  const closedFace = { ...face, ...fixtureMesh({ ...positions, 0: [.5, .66], 17: [.5, .66] }, [.5, .5], [.4, .4, .6, .4]) };
  await call('SetSourceFilterSettings', { sourceName, filterName, filterSettings: { teeth: 1, fixture_json: JSON.stringify({ version: 3, mode: 'static-fixture', faces: [closedFace] }) } });
  assert.deepEqual((await screenshot('teeth-closed-mouth', sourceName)).data, baseline.data, 'Closed mouth must remain unchanged');
  return results;
}
