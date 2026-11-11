/**
 * A key with the modifiers held for it, spelt one way everywhere: `Ctrl+Alt+Shift+Meta+<event.code>`, each modifier
 * only when held, always in that order. It is what the lighting shortcuts (`tblink.timeline-shortcuts`) and the songs'
 * own shortcuts (`playback.shortcut`) have been saved as, so saved keys are read as they are. `event.code` is the
 * key's place on the keyboard, the same whatever the input method or layout types with it.
 */
export type KeyChord = string;

/** A chord taken apart. */
export type ParsedChord = { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; code: string };

type ChordEvent = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;

/**
 * The chord of a key press. `meta: false` leaves the Meta (Windows) key out, as a song's shortcut has always been
 * recorded: the window never plays a song while Meta is held, so a song's shortcut stays without it.
 */
export function chordOf(event: ChordEvent, options: { meta?: boolean } = {}): KeyChord {
  const meta = options.meta !== false && event.metaKey;
  return [...(event.ctrlKey ? ['Ctrl'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), ...(meta ? ['Meta'] : []), event.code].join('+');
}

/** The parts of a chord, or null when it is not spelt the one way (`chordOf`). */
export function parseChord(chord: KeyChord): ParsedChord | null {
  const parts = chord.split('+');
  const code = parts.pop();
  if (!code || MODIFIERS.some(modifier => modifier === code)) return null;
  let at = 0;
  for (const part of parts) {
    const index = MODIFIERS.findIndex(modifier => modifier === part);
    if (index < at) return null;
    at = index + 1;
  }
  return { ctrl: parts.includes('Ctrl'), alt: parts.includes('Alt'), shift: parts.includes('Shift'), meta: parts.includes('Meta'), code };
}

const KEY_NAMES: Readonly<Record<string, string>> = {
  Space: '空格', Escape: 'Esc', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  Equal: '=', Minus: '-', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Backquote: '`'
};

/** The name of a key as people read it: `Shift+Esc`, `空格`, `←`, `F5`, `Ctrl+=`, `Ctrl+B`. */
export function chordLabel(chord: KeyChord): string {
  const parsed = parseChord(chord);
  if (!parsed) return chord;
  const letter = /^Key([A-Z])$/.exec(parsed.code)?.[1] ?? /^Digit(\d)$/.exec(parsed.code)?.[1];
  const name = letter ?? KEY_NAMES[parsed.code] ?? parsed.code;
  return [...(parsed.ctrl ? ['Ctrl'] : []), ...(parsed.alt ? ['Alt'] : []), ...(parsed.shift ? ['Shift'] : []), ...(parsed.meta ? ['Meta'] : []), name].join('+');
}

/**
 * Chords Windows or the input method takes before the window sees them, or that do something else there: the Start
 * menu (Ctrl+Esc), switching windows (Alt+Esc, Alt+Tab), the Task Manager (Ctrl+Shift+Esc), closing the window
 * (Alt+F4), the window menu (Alt+Space), switching between Chinese and English input (Ctrl+Space), and every chord
 * with the Windows key. None of them can be a shortcut.
 */
const SYSTEM_CHORDS: ReadonlySet<KeyChord> = new Set(['Ctrl+Escape', 'Ctrl+Shift+Escape', 'Alt+Escape', 'Alt+Tab', 'Alt+Shift+Tab', 'Alt+F4', 'Alt+Space', 'Ctrl+Space', 'Ctrl+Alt+Delete']);

/** Whether a chord belongs to Windows or the input method (`SYSTEM_CHORDS`), not to the app. */
export function isSystemChord(chord: KeyChord): boolean {
  const parsed = parseChord(chord);
  return parsed !== null && (parsed.meta || SYSTEM_CHORDS.has(chord));
}
