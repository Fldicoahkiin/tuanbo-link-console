import type { ReleaseNote } from '../../../../../../scripts/release-notes.mjs';

export type { ReleaseNote, ReleaseNoteBlock, ReleaseNoteInline } from '../../../../../../scripts/release-notes.mjs';

/** Written by electron.vite.config.ts from release-notes/: this version and every earlier one, newest first. */
declare const __TBLINK_RELEASE_NOTES__: readonly ReleaseNote[];
// Component tests bundle the renderer without electron-vite and so without release notes (as build-identity.ts does).
export const bundledReleaseNotes: readonly ReleaseNote[] = typeof __TBLINK_RELEASE_NOTES__ === 'undefined' ? [] : __TBLINK_RELEASE_NOTES__;
