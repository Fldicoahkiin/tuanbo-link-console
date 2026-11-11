import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkCue } from '@tb/schema';
import { emptyInternalPlayerState, type ResolvedTimelineState } from '@tb/core/link';
import { PlayerViewStore } from '../stores/player-view-store';
import type { ProjectPlayer } from './ProjectPlayerControls';
import type { EditorPlayhead } from './editor-playhead';

// The render count guard of 0.5.9 E2 (05 设计 4.11): while 联动台播放 plays, the playhead moves every frame
// but the editor page draws again only when it crosses a part's start or end. The test environment has no
// browser, so React draws into the smallest document that react-dom needs, set up before it loads; the
// timeline, the stage and the inspector are stand-ins that only record what the page hands them.
vi.hoisted(() => {
  type Child = FakeNode;
  class FakeNode {
    parentNode: FakeNode | null = null;
    childNodes: Child[] = [];
    constructor(readonly nodeType: number, readonly nodeName: string, public ownerDocument: FakeNode | null) {}
    get firstChild(): Child | null { return this.childNodes[0] ?? null; }
    get lastChild(): Child | null { return this.childNodes.at(-1) ?? null; }
    get nextSibling(): Child | null { const siblings = this.parentNode?.childNodes ?? []; return siblings[siblings.indexOf(this) + 1] ?? null; }
    get textContent(): string { return this.childNodes.map(child => child.textContent).join(''); }
    set textContent(value: string) { for (const child of this.childNodes) child.parentNode = null; this.childNodes = []; if (value) this.appendChild(new FakeText(value, this.ownerDocument)); }
    appendChild(child: Child): Child { child.parentNode?.removeChild(child); this.childNodes.push(child); child.parentNode = this; return child; }
    insertBefore(child: Child, before: Child | null): Child {
      if (!before) return this.appendChild(child);
      child.parentNode?.removeChild(child);
      this.childNodes.splice(this.childNodes.indexOf(before), 0, child); child.parentNode = this; return child;
    }
    removeChild(child: Child): Child { this.childNodes.splice(this.childNodes.indexOf(child), 1); child.parentNode = null; return child; }
    contains(node: FakeNode | null): boolean { for (let at = node; at; at = at.parentNode) if (at === this) return true; return false; }
    addEventListener(): void { /* events are not sent in this test */ }
    removeEventListener(): void { /* events are not sent in this test */ }
  }
  class FakeText extends FakeNode {
    constructor(public nodeValue: string, owner: FakeNode | null) { super(3, '#text', owner); }
    override get textContent(): string { return this.nodeValue; }
    override set textContent(value: string) { this.nodeValue = value; }
  }
  const style = (): Record<string, unknown> => {
    const values: Record<string, unknown> = {};
    return Object.assign(values, { setProperty: (name: string, value: string) => { values[name] = value; }, removeProperty: (name: string) => { delete values[name]; }, getPropertyValue: (name: string) => { const value = values[name]; return typeof value === 'string' ? value : ''; } });
  };
  class FakeElement extends FakeNode {
    readonly attributes = new Map<string, string>();
    readonly style = style();
    readonly classList = { add: (): void => undefined, remove: (): void => undefined, contains: (): boolean => false };
    constructor(readonly tagName: string, readonly namespaceURI: string, owner: FakeNode | null) { super(1, tagName, owner); }
    setAttribute(name: string, value: unknown): void { this.attributes.set(name, String(value)); }
    setAttributeNS(_space: string, name: string, value: unknown): void { this.attributes.set(name, String(value)); }
    getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
    hasAttribute(name: string): boolean { return this.attributes.has(name); }
    removeAttribute(name: string): void { this.attributes.delete(name); }
    removeAttributeNS(_space: string, name: string): void { this.attributes.delete(name); }
    getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    closest(): null { return null; }
    querySelector(): null { return null; }
    querySelectorAll(): never[] { return []; }
    focus(): void { /* nothing takes focus in this test */ }
    blur(): void { /* nothing takes focus in this test */ }
  }
  const html = 'http://www.w3.org/1999/xhtml';
  const document = new FakeNode(9, '#document', null) as FakeNode & Record<string, unknown>;
  const root = new FakeElement('HTML', html, document);
  const body = new FakeElement('BODY', html, document);
  root.appendChild(body); document.appendChild(root);
  Object.assign(document, { documentElement: root, body, activeElement: null,
    createElement: (tag: string) => new FakeElement(tag.toUpperCase(), html, document),
    createElementNS: (space: string, tag: string) => new FakeElement(tag, space, document),
    createTextNode: (text: string) => new FakeText(text, document),
    querySelector: () => null, querySelectorAll: () => [] });
  const saved = new Map<string, string>();
  const window = { document, event: undefined, innerWidth: 1280, innerHeight: 720, HTMLIFrameElement: class {},
    addEventListener: (): void => undefined, removeEventListener: (): void => undefined,
    requestAnimationFrame: (): number => 0, cancelAnimationFrame: (): void => undefined,
    localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); },
      removeItem: (key: string) => { saved.delete(key); }, clear: () => saved.clear(), key: () => null, length: 0 } };
  Object.assign(globalThis, { window, document, localStorage: window.localStorage, requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame, IS_REACT_ACT_ENVIRONMENT: true });
});

// The renderer's TSX compiles to React.createElement here.
vi.stubGlobal('React', React);
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: {} }));
const seen = vi.hoisted(() => ({ states: [] as ResolvedTimelineState[], playhead: null as EditorPlayhead | null, scene: undefined as { cueId: string } | null | undefined }));
vi.mock('./ReferenceTimeline', () => ({ ReferenceTimeline: (props: { timelineState: ResolvedTimelineState; playhead: EditorPlayhead }) => {
  if (seen.states.at(-1) !== props.timelineState) seen.states.push(props.timelineState);
  seen.playhead = props.playhead;
  return null;
} }));
vi.mock('./ReferenceStage', () => ({ ReferenceStage: (props: { scenePreview: { cueId: string } | null }) => { seen.scene = props.scenePreview; return null; } }));
vi.mock('./CommonProperties', () => ({ CommonProperties: () => null }));

const { createRoot } = await import('react-dom/client');
const { useDocumentStore } = await import('../stores/document-store');
const { CueWorkspace } = await import('./CueWorkspace');

let unmount: (() => void) | null = null;
afterEach(() => {
  React.act(() => { unmount?.(); });
  unmount = null;
  useDocumentStore.getState().setProject(null, null);
});

const at = (seconds: number) => ({ hours: 0, minutes: 0, seconds, frames: 0 });
const camera = (id: string, seconds: number): LinkCue => ({
  id, name: `机位 ${id}`, enabled: true, notes: '', timecode: at(seconds), durationMs: 2_000, layerId: 'cameras',
  actions: [{ id: `${id}-scene`, label: `切到 ${id}`, kind: 'obs.setProgramScene', sceneName: `机位 ${id}` }]
});

describe('播放时编辑器不每帧重画（0.5.9 E2）', () => {
  it('假时钟 1 秒推 200 次、跨过 1 个机位边界：编辑器的渲染次数 ≤ 跨过的边界数 + 2，播放头照常走到 2.5 秒', () => {
    const project = parseLinkProject({ ...createEmptyLinkProject('现场'), playbackSource: 'internal', obsOutputMode: 'scenes', rundown: [{ id: 'song', title: '第三首', enabled: true, notes: '',
      visualLayers: [{ id: 'cameras', name: '轨道 1', visible: true, locked: false }], cues: [camera('a', 2), camera('b', 8)] }] });
    useDocumentStore.getState().setProject(project, 'C:/show/现场.tblink');
    const frames: Array<() => void> = [];
    const view = new PlayerViewStore(callback => { frames.push(callback); });
    const tick = (): void => { for (const frame of frames.splice(0)) frame(); };
    view.publish({ ...emptyInternalPlayerState, status: 'playing', itemId: 'song', positionMs: 1_500, durationMs: 20_000 });
    const player: ProjectPlayer = { controller: null, state: view.readControl(), view, engine: '联动台播放', outdated: false };

    let renders = 0;
    const container = document.createElement('div');
    const root = createRoot(container);
    unmount = () => root.unmount();
    React.act(() => {
      root.render(React.createElement(React.Profiler, { id: 'CueWorkspace', onRender: () => { renders += 1; } },
        React.createElement(CueWorkspace, { player, playbackProject: project, sidebarHost: null, toolbarHost: null, syncHost: null, coordinator: null,
          notify: vi.fn(), documentActions: { canUndo: false, canRedo: false, disabled: true, onUndo: vi.fn(), onRedo: vi.fn(), onSave: vi.fn() } })));
    });
    // Before 2 s no camera is on: the preview drawn without OBS shows none.
    expect(seen.scene).toBeNull();
    const moves: number[] = [];
    seen.playhead?.subscribeFrame(positionMs => moves.push(positionMs));

    renders = 0;
    // 200 clock events 5 ms apart, one frame each: 1.5 s → 2.5 s, across camera a's start at 2 s.
    for (let step = 1; step <= 200; step += 1) {
      view.publish({ ...emptyInternalPlayerState, status: 'playing', itemId: 'song', positionMs: 1_500 + step * 5, durationMs: 20_000 });
      React.act(tick);
    }
    // Camera a's start is the one boundary crossed: the page drew again for it, and not every frame.
    expect(renders).toBeGreaterThanOrEqual(1);
    expect(renders).toBeLessThanOrEqual(1 + 2);
    // The playhead still moved every frame, and the page heard the camera switch.
    expect(moves).toHaveLength(200);
    expect(seen.playhead?.read()).toBe(2_500);
    expect(seen.scene?.cueId).toBe('a');
    expect(seen.states.at(-1)?.itemId).toBe('song');
  });
});
