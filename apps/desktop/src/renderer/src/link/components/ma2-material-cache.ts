import { ma2CatalogRequestSchema, ma2EffectLibrarySchema, type Ma2CatalogRequest, type Ma2EffectLibrary } from '@tb/schema';

type MaterialCache = { source: Ma2CatalogRequest; library: Ma2EffectLibrary };
const key = 'tblink.ma2.material-cache.v1';
let inMemory: MaterialCache | null = null;

export function loadMa2MaterialCache(): MaterialCache | null {
  if (inMemory) return inMemory;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || !('source' in value) || !('library' in value)) throw new Error('上次控台素材缓存格式无效，请重新读取');
  const source = ma2CatalogRequestSchema.parse(value.source);
  const library = ma2EffectLibrarySchema.parse(value.library);
  inMemory = { source, library };
  return inMemory;
}

export function rememberMa2MaterialCache(source: Ma2CatalogRequest, library: Ma2EffectLibrary): void {
  const cleanSource = ma2CatalogRequestSchema.parse({ dataDirectory: source.dataDirectory, ...(source.network ? { network: source.network } : {}) });
  const cache = { source: cleanSource, library: ma2EffectLibrarySchema.parse(library) };
  inMemory = cache;
  // Only network identity and read-only Cue metadata are persisted. No credentials or local paths.
  if (source.network) localStorage.setItem(key, JSON.stringify(cache));
}
