import type { ObsLiveItem } from '@tb/schema';

type Transform = ObsLiveItem['sceneItemTransform'];
type Direction = { x: number; y: number };

// Match OBS scene-item box_transform, not the source's uncropped width/height.
export function obsItemBoxSize(t: Transform): { width: number; height: number } {
  if (t.boundsType !== 'OBS_BOUNDS_NONE') return { width: t.boundsWidth, height: t.boundsHeight };
  const width = t.sourceWidth - t.cropLeft - t.cropRight;
  const height = t.sourceHeight - t.cropTop - t.cropBottom;
  return { width: (width < 0 ? 2 : width) * t.scaleX, height: (height < 0 ? 2 : height) * t.scaleY };
}

function anchor(alignment: number): Direction { return { x: alignment & 1 ? 0 : alignment & 2 ? 1 : .5, y: alignment & 4 ? 0 : alignment & 8 ? 1 : .5 }; }
function rotate(x: number, y: number, degrees: number): Direction {
  const angle = degrees * Math.PI / 180;
  return { x: x * Math.cos(angle) - y * Math.sin(angle), y: x * Math.sin(angle) + y * Math.cos(angle) };
}
export function obsItemCenter(t: Transform): Direction {
  const box = obsItemBoxSize(t);
  const a = anchor(t.alignment), delta = rotate((.5 - a.x) * box.width, (.5 - a.y) * box.height, t.rotation);
  return { x: t.positionX + delta.x, y: t.positionY + delta.y };
}
export function resizeObsLiveItem(t: Transform, direction: Direction, dx: number, dy: number, stretch: boolean): Transform {
  const local = rotate(dx, dy, -t.rotation);
  const box = obsItemBoxSize(t);
  const width = Math.abs(box.width), height = Math.abs(box.height);
  if (width === 0 || height === 0) return t;
  let fx = Math.max(.01, 1 + direction.x * local.x / width), fy = Math.max(.01, 1 + direction.y * local.y / height);
  if (!stretch) fx = fy = Math.abs(fx - 1) >= Math.abs(fy - 1) ? fx : fy;
  const originalCenter = obsItemCenter(t);
  const shift = rotate(direction.x * width * (fx - 1) / 2, direction.y * height * (fy - 1) / 2, t.rotation);
  const a = anchor(t.alignment), offset = rotate((.5 - a.x) * box.width * fx, (.5 - a.y) * box.height * fy, t.rotation);
  return { ...t,
    positionX: originalCenter.x + shift.x - offset.x, positionY: originalCenter.y + shift.y - offset.y,
    ...(t.boundsType === 'OBS_BOUNDS_NONE' ? { width: t.width * fx, height: t.height * fy, scaleX: t.scaleX * fx, scaleY: t.scaleY * fy } : { boundsWidth: t.boundsWidth * fx, boundsHeight: t.boundsHeight * fy }) };
}
