import { describe, expect, it } from 'vitest';
import { rendererSource } from './renderer-source';

describe('rendererSource', () => {
  it('loads the development server only in an unpackaged app', () => {
    expect(rendererSource(false, 'http://localhost:5173')).toEqual({ kind: 'url', url: 'http://localhost:5173' });
    expect(rendererSource(false, undefined)).toEqual({ kind: 'file' });
  });

  it('ignores ELECTRON_RENDERER_URL in a packaged app', () => {
    expect(rendererSource(true, 'http://192.168.1.20:5173')).toEqual({ kind: 'file' });
    expect(rendererSource(true, 'https://example.com/')).toEqual({ kind: 'file' });
  });
});
