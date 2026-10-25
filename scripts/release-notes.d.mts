// Types for scripts/release-notes.mjs, which the desktop build and renderer import.
export type ReleaseNoteInline = { readonly text: string; readonly strong: boolean };
export type ReleaseNoteBlock =
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'paragraph'; readonly content: readonly ReleaseNoteInline[] }
  | { readonly kind: 'list'; readonly items: readonly (readonly ReleaseNoteInline[])[] };
export type ReleaseNote = { readonly version: string; readonly blocks: readonly ReleaseNoteBlock[] };

export function compareVersions(left: string, right: string): number;
export function parseReleaseNotes(version: string, text: string): ReleaseNote;
export function readReleaseNotes(directory: string): ReleaseNote[];
export function notesUpTo(notes: readonly ReleaseNote[], version: string): ReleaseNote[];
export function renderChangelog(notes: readonly ReleaseNote[], packageVersion: string): string;
export function renderMarkdown(note: ReleaseNote): string;
