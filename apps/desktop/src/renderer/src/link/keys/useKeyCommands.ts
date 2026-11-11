import { useEffect, useRef } from 'react';
import { keyRouter, type KeyClaim, type KeyHandlers, type KeyWhen, type SongShortcuts } from './key-router';
import type { KeyPage, KeyScope } from './keymap';

/*
 * How components hand their keys to the window's one key listener (key-router.ts). Each hook registers once while the
 * component is there and reads the latest handlers from a ref, so a page redrawn many times a second (the clock while
 * playing) does not take its keys off and put them on again.
 */

/** Installs the router on the window, once, for the app (LinkApp). */
export function useKeyRouter(): void {
  useEffect(() => keyRouter.install(window), []);
}

/** Tells the router which page is on screen (LinkApp). */
export function usePageScope(page: KeyPage): void {
  useEffect(() => keyRouter.setPage(page), [page]);
}

/**
 * The commands this component does with the keys in `scope` (keymap.ts), while `when` says so; none while `handlers`
 * is null (no player, no song open).
 */
export function useKeyCommands(scope: KeyScope, handlers: KeyHandlers | null, when?: KeyWhen): void {
  const latest = useRef({ handlers, when });
  latest.current = { handlers, when };
  const active = handlers !== null;
  useEffect(() => {
    if (!active) return;
    return keyRouter.register(scope, () => latest.current.handlers ?? {}, press => latest.current.handlers !== null && (latest.current.when?.(press) ?? true));
  }, [scope, active]);
}

/** The songs' own shortcuts, while `songs` is there (联动台播放 with a player). */
export function useSongShortcuts(songs: SongShortcuts | null): void {
  const latest = useRef(songs);
  latest.current = songs;
  const active = songs !== null;
  useEffect(() => {
    if (!active) return;
    return keyRouter.songShortcuts({ find: chord => latest.current?.find(chord), play: itemId => latest.current?.play(itemId) });
  }, [active]);
}

/**
 * A panel that closes itself on Escape, open while `open` says so (a getter for one the page opens without React, a
 * <details>). `blocks`: the window's keys wait while it is open (the settings and connection page, 0.5.9).
 */
export function useKeyOverlay(open: boolean | (() => boolean), blocks = false): void {
  const latest = useRef(open);
  latest.current = open;
  const shown = open !== false;
  useEffect(() => {
    if (!shown) return;
    return keyRouter.overlay({ open: () => { const value = latest.current; return typeof value === 'function' ? value() : value; }, blocks });
  }, [shown, blocks]);
}

/**
 * A listener of the page that is not on the router yet says which keys it takes (`claim`), so the window's keys leave
 * them to it, as they did when it took them first (the lighting workbench's shortcut keys, until K6).
 */
export function useKeyClaim(claim: KeyClaim | null): void {
  const latest = useRef(claim);
  latest.current = claim;
  const active = claim !== null;
  useEffect(() => {
    if (!active) return;
    return keyRouter.claim((event, target) => latest.current?.(event, target) ?? false);
  }, [active]);
}
