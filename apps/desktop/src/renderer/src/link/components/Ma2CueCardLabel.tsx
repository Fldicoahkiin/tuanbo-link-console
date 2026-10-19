import type { LibrarySequence } from '../view-models/ma2-sequence-library';
import { currentMa2LayoutScope } from '../stores/ma2-layout-store';
import { ma2SequenceLocations, useMa2ExecutorPageStore } from '../stores/ma2-executor-page-store';

/** Keep the actual Cue address distinct from its position in the unfiltered Sequence. */
export function Ma2CueCardLabel({ sequence, cue, name }: { sequence: LibrarySequence; cue: LibrarySequence['cues'][number]; name: string }): JSX.Element {
  const pages = useMa2ExecutorPageStore();
  const locations = pages.scope === currentMa2LayoutScope() ? ma2SequenceLocations(pages.pages, sequence.sequence) : [];
  const position = sequence.cues.findIndex(value => Number(value.number) === Number(cue.number));
  const cueLabel = `Cue ${Number(cue.number)}`;
  return <span className="ma2-cue-card-label">
    <strong>{name}</strong>
    <small>{name !== cueLabel ? <span>{cueLabel}</span> : null}{sequence.complete && sequence.cues.length > 1 && position >= 0 ? <span>第 {position + 1} 步</span> : null}{locations[0] ? <span title={locations.map(value => `${value.page} 页 · ${value.slot} 格`).join('；')}>{locations[0].page} 页 · {locations[0].slot} 格{locations.length > 1 ? ` +${locations.length - 1}` : ''}</span> : null}</small>
  </span>;
}
