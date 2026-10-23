export type RendererSource = { kind: 'url'; url: string } | { kind: 'file' };

/** A packaged app always loads its own asar renderer: the page gets the full preload API,
 * so an environment variable must not be able to point it at another origin. */
export function rendererSource(packaged: boolean, developmentUrl: string | undefined): RendererSource {
  return !packaged && developmentUrl ? { kind: 'url', url: developmentUrl } : { kind: 'file' };
}
