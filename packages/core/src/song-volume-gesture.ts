/** What the player-bar slider does with one event: play the value without saving it, save it, or nothing. */
export type SongVolumeStep =
  | { kind: 'none' }
  | { kind: 'preview'; itemId: string; volume: number }
  | { kind: 'commit'; itemId: string; volume: number; gestureId: string };

const none: SongVolumeStep = { kind: 'none' };

/**
 * The gestures of the player-bar slider, which shows and changes the song's own saved volume (2026-11-09,
 * docs/SONG_VOLUME.md). A pointer drag is heard while it moves and saved once, when it is let go; it saves into the song
 * it started on. With the keyboard every key press saves, and the presses of one focus are one gesture, so one undo
 * step (`setItemVolumeCommand` groups the history by `gestureId`).
 */
export class SongVolumeGesture {
  private drag: { itemId: string; gestureId: string; volume: number | null } | null = null;
  private keys: string;

  constructor(private readonly newId: () => string = () => crypto.randomUUID()) { this.keys = newId(); }

  /** The song a drag in progress changes; null while none is. */
  get dragging(): string | null { return this.drag?.itemId ?? null; }
  /** The slider got the focus: the key presses from now on are one gesture. */
  focus(): void { this.keys = this.newId(); }
  /** The pointer went down on the slider of `itemId`: a drag starts. */
  press(itemId: string): void { this.drag = { itemId, gestureId: this.newId(), volume: null }; }
  /** The slider's value moved: during a drag it is heard, otherwise (a key press) it is saved into `itemId`. */
  input(itemId: string, volume: number): SongVolumeStep {
    if (this.drag) { this.drag.volume = volume; return { kind: 'preview', itemId: this.drag.itemId, volume }; }
    return { kind: 'commit', itemId, volume, gestureId: this.keys };
  }
  /** The pointer was let go (pointerup, the change event, or the pointer was taken away): the drag saves once. */
  release(): SongVolumeStep {
    const drag = this.drag; this.drag = null;
    if (!drag || drag.volume === null) return none;
    // Key presses after a drag are a gesture of their own.
    this.keys = this.newId();
    return { kind: 'commit', itemId: drag.itemId, volume: drag.volume, gestureId: drag.gestureId };
  }
}
