import { describe, expect, it } from 'vitest';
import type { ObsLiveItem } from '@tb/schema';
import { obsItemBoxSize, obsItemCenter, resizeObsLiveItem } from './obs-live-geometry';

const video: ObsLiveItem['sceneItemTransform'] = {
  positionX: 1080, positionY: 1920, scaleX: 1, scaleY: 1, rotation: 0,
  cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0, alignment: 0,
  sourceWidth: 448, sourceHeight: 960, width: 448, height: 960,
  boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 2160, boundsHeight: 3840
};

describe('OBS selection box geometry', () => {
  it('uses the OBS bounding rectangle for fitted portrait video', () => {
    expect(obsItemBoxSize(video)).toEqual({ width: 2160, height: 3840 });
    expect(obsItemCenter(video)).toEqual({ x: 1080, y: 1920 });
  });
  it('resizes bounds with the opposite corner fixed and source scale unchanged', () => {
    const result = resizeObsLiveItem(video, { x: 1, y: 1 }, 216, 384, false);
    expect(result.boundsWidth).toBeCloseTo(2376);
    expect(result.boundsHeight).toBeCloseTo(4224);
    expect(result.positionX - result.boundsWidth / 2).toBeCloseTo(0);
    expect(result.positionY - result.boundsHeight / 2).toBeCloseTo(0);
    expect(result.scaleX).toBe(1);
    expect(result.width).toBe(448);
  });
  it('uses cropped, signed scale for sources without bounds', () => {
    const source = { ...video, boundsType: 'OBS_BOUNDS_NONE', alignment: 5,
      positionX: 500, positionY: 100, cropLeft: 48, cropTop: 60, scaleX: -2, scaleY: 2 };
    expect(obsItemBoxSize(source)).toEqual({ width: -800, height: 1800 });
    expect(obsItemCenter(source)).toEqual({ x: 100, y: 1000 });
    const resized = resizeObsLiveItem(source, { x: 1, y: 0 }, 80, 0, true);
    const box = obsItemBoxSize(resized);
    expect(box.width).toBeCloseTo(-880);
    expect(obsItemCenter(resized).x - Math.abs(box.width) / 2).toBeCloseTo(-300);
  });
  it('resizes a rotated box along its local axes without shifting the opposite edge', () => {
    const rotated = { ...video, rotation: 90, alignment: 5, positionX: 0, positionY: 0 };
    const result = resizeObsLiveItem(rotated, { x: 1, y: 1 }, -384, 216, false);
    expect(result.positionX).toBeCloseTo(0);
    expect(result.positionY).toBeCloseTo(0);
    expect(result.boundsWidth).toBeCloseTo(2376);
    expect(result.boundsHeight).toBeCloseTo(4224);
  });
});
