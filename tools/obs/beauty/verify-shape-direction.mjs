import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureMesh } from './fixture-mesh.mjs';
import { verifyMakeup } from './verify-makeup.mjs';
import { verifyOutline } from './verify-outline.mjs';
import { verifyRetouch } from './verify-retouch.mjs';
import { verifyBlemish } from './verify-blemish.mjs';
import { verifyTeeth } from './verify-teeth.mjs';

export async function verifyShapeDirection({ call, screenshot, directory, PNG }) {
  const sourceName = 'Shape direction fixture', filterName = 'Direction probe';
  const image = new PNG({ width: 800, height: 800 });
  for (let y = 0; y < 800; y++) for (let x = 0; x < 800; x++) {
    const u = x / 800, v = y / 800;
    let color = [200, 150, 115, 255];
    if (u > .47 && u < .53 && v > .48 && v < .55) color = [255, 0, 255, 255];
    if (u > .46 && u < .54 && v > .65 && v < .67) color = [0, 255, 255, 255];
    if (Math.abs(u - .4) < .015 && Math.abs(v - .4) < .015) color = [0, 255, 0, 255];
    if (Math.abs(u - .6) < .015 && Math.abs(v - .4) < .015) color = [255, 255, 0, 255];
    image.data.set(color, (y * 800 + x) * 4);
  }
  const path = join(directory, 'shape-markers.png');
  await writeFile(path, PNG.sync.write(image));
  const positions = { 1: [.5, .51], 98: [.46, .52], 327: [.54, .52], 61: [.43, .66], 291: [.57, .66],
    0: [.5, .64], 17: [.5, .68], 13: [.5, .655], 14: [.5, .665], 152: [.5, .85], 10: [.5, .15] };
  const face = { cx: .5, cy: .5, rx: .4, ry: .4, lx: .4, ly: .4, ex: .6, ey: .4, smooth: 0, white: 0, slim: 0, eye: 0,
    ...fixtureMesh(positions, [.5, .5], [.4, .4, .6, .4]) };
  await call('CreateInput', { sceneName: 'Beauty', inputName: sourceName, inputKind: 'image_source', inputSettings: { file: path }, sceneItemEnabled: false });
  await call('CreateSourceFilter', { sourceName, filterName, filterKind: 'tblink_beauty_prototype',
    filterSettings: { fixture_json: JSON.stringify({ version: 3, mode: 'static-fixture', faces: [face] }) } });
  const stats = pixels => {
    const regions = Object.fromEntries(['nose', 'mouth', 'left', 'right'].map(key => [key, { count: 0, sumX: 0, minX: 800, maxX: 0, minY: 800, maxY: 0 }]));
    for (let y = 0; y < pixels.height; y++) for (let x = 0; x < pixels.width; x++) {
      const i = (y * pixels.width + x) * 4, r = pixels.data[i], g = pixels.data[i + 1], b = pixels.data[i + 2];
      const key = r > 200 && b > 200 && g < 40 ? 'nose' : g > 200 && b > 200 && r < 40 ? 'mouth'
        : g > 200 && r < 40 && b < 40 ? 'left' : r > 200 && g > 200 && b < 40 ? 'right' : null;
      if (!key) continue;
      const region = regions[key]; region.count++; region.sumX += x;
      region.minX = Math.min(region.minX, x); region.maxX = Math.max(region.maxX, x);
      region.minY = Math.min(region.minY, y); region.maxY = Math.max(region.maxY, y);
    }
    for (const region of Object.values(regions)) assert(region.count > 0, 'Direction marker disappeared');
    return { noseWidth: regions.nose.maxX - regions.nose.minX, noseHeight: regions.nose.maxY - regions.nose.minY,
      mouthWidth: regions.mouth.maxX - regions.mouth.minX,
      eyeDistance: regions.right.sumX / regions.right.count - regions.left.sumX / regions.left.count };
  };
  const baseline = stats(await screenshot('direction-neutral', sourceName));
  const reports = { baseline };
  const neutral = { nose: 0, noseLength: 0, mouth: 0, eyeDistance: 0 };
  for (const [key, measurement] of [['nose', 'noseWidth'], ['noseLength', 'noseHeight'], ['mouth', 'mouthWidth'], ['eyeDistance', 'eyeDistance']]) {
    for (const strength of (key === 'nose' ? [1] : [-1, 1])) {
      await call('SetSourceFilterSettings', { sourceName, filterName, filterSettings: { ...neutral, [key]: strength } });
      const result = stats(await screenshot(`direction-${key}-${strength}`, sourceName));
      reports[`${key}:${strength}`] = result;
      if (key === 'mouth' || key === 'eyeDistance') {
        assert.equal(result.noseWidth, baseline.noseWidth, `${key} changed nose width`);
        assert.equal(result.noseHeight, baseline.noseHeight, `${key} changed nose height`);
      }
      if (key === 'nose' || strength < 0) assert(result[measurement] < baseline[measurement], `${key} did not shrink in expected direction`);
      else assert(result[measurement] > baseline[measurement], `${key} did not expand in expected direction`);
    }
  }
  await call('SetSourceFilterSettings', { sourceName, filterName, filterSettings: neutral });
  const unpainted = await screenshot('lipstick-original', sourceName);
  await call('SetSourceFilterSettings', { sourceName, filterName, filterSettings: { lipstick: 1 } });
  const painted = await screenshot('lipstick-painted', sourceName);
  let holePixels = 0, changed = 0;
  for (let y = 0; y < 800; y++) for (let x = 0; x < 800; x++) {
    const offset = (y * 800 + x) * 4;
    const delta = [0, 1, 2].reduce((sum, channel) => sum + Math.abs(painted.data[offset + channel] - unpainted.data[offset + channel]), 0);
    changed += delta;
    assert.equal(painted.data[offset + 3], unpainted.data[offset + 3], 'Lipstick changed alpha');
    if (((x / 800 - .5) / (.07 * .75 * .5)) ** 2 + ((y / 800 - .66) / (.02 * .35 * .5)) ** 2 < 1) {
      holePixels++; assert.equal(delta, 0, 'Lipstick painted the mouth opening');
    }
    if (x / 800 < .4275 || x / 800 > .5725 || y / 800 < .6375 || y / 800 > .6825)
      assert.equal(delta, 0, 'Lipstick changed pixels outside lips');
  }
  assert(holePixels > 0 && changed > 0, 'Lipstick test did not exercise both pigment and mouth opening');
  await call('SetSourceFilterSettings', { sourceName, filterName, filterSettings: { lipstick: 0 } });
  assert.deepEqual((await screenshot('lipstick-reset', sourceName)).data, unpainted.data, 'Lipstick zero did not restore image');
  reports.lipstick = { holePixels, changed };
  reports.makeup = await verifyMakeup({ call, screenshot, sourceName, filterName });
  reports.outline = await verifyOutline({ call, screenshot, directory, PNG });
  reports.retouch = await verifyRetouch({ call, screenshot, directory, PNG });
  reports.blemish = await verifyBlemish({ call, screenshot, directory, PNG });
  reports.teeth = await verifyTeeth({ call, screenshot, directory, PNG });
  return reports;
}
