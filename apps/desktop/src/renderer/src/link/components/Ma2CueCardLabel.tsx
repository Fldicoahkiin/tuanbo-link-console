import type { LibrarySequence } from '../view-models/ma2-sequence-library';
import { currentMa2LayoutScope } from '../stores/ma2-layout-store';
import { ma2SequenceLocations, useMa2ExecutorPageStore } from '../stores/ma2-executor-page-store';

/**
 * A Cue card: its name, then the Cue number once (2026-10-28, picture 10: an unnamed Cue read
 * "Cue 3 · 第 3 步"). The step in the Sequence shows only where it differs from the Cue number,
 * such as Cue 2.5 being the third step.
 */
export function Ma2CueCardLabel({ sequence, cue, name }: { sequence: LibrarySequence; cue: LibrarySequence['cues'][number]; name: string }): JSX.Element {
  const pages = useMa2ExecutorPageStore();
  const locations = pages.scope === currentMa2LayoutScope() ? ma2SequenceLocations(pages.pages, sequence.sequence) : [];
  const position = sequence.cues.findIndex(value => Number(value.number) === Number(cue.number));
  const cueLabel = `Cue ${Number(cue.number)}`;
  const step = sequence.complete && sequence.cues.length > 1 && position >= 0 && position + 1 !== Number(cue.number) ? position + 1 : null;
  return <span className="ma2-cue-card-label">
    <strong>{name}</strong>
    <small>{name !== cueLabel ? <span>{cueLabel}</span> : null}{step !== null ? <span>第 {step} 步</span> : null}{locations[0] ? <span title={locations.map(value => `${value.page} 页 · ${value.slot} 格`).join('；')}>{locations[0].page} 页 · {locations[0].slot} 格{locations.length > 1 ? ` +${locations.length - 1}` : ''}</span> : null}</small>
  </span>;
}
