import type { LinkObsInventory } from '@tb/core/link';

export const MEDIA_DRAG_TYPE = 'application/x-tblink-media-asset';
export const OBS_DRAG_TYPE = 'application/x-tblink-obs-resource';

/** An OBS scene in the library. Each camera is one scene. */
export type ObsResource = { id: string; kind: 'scene'; name: string };

export function parseObsResource(value: string): ObsResource {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed) || parsed.kind !== 'scene' || typeof parsed.name !== 'string') throw new Error('拖进来的不是 OBS 场景，请从资源库的场景列表里拖');
  return obsSceneResource(parsed.name);
}

export function buildObsVisualResources(inventory: LinkObsInventory | null): ObsResource[] {
  return inventory?.scenes.map(obsSceneResource) ?? [];
}

function obsSceneResource(name: string): ObsResource {
  return { id: `scene:${name}`, kind: 'scene', name };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
