import type { LightingDocument, LinkProject } from '@tb/schema';
import { consoleCueKey, pendingMa2Renames, projectLightingLibrary } from '@tb/core/link';

export type LibrarySequence = { sequence: number; name: string | null; originalName?: string | null; renamedName?: string | undefined; cues: { number: string; name: string | null; originalName?: string | null; renamedName?: string | undefined }[]; complete: boolean };

function consoleName(value: { name: string | null; originalName?: string | null; renamedName?: string | undefined }): string | null {
  const name = value.renamedName ?? (value.originalName === undefined ? value.name : value.originalName);
  return name?.trim() ? name : null;
}

export function ma2ConsoleSequenceName(sequence: LibrarySequence): string {
  return consoleName(sequence) ?? `序列 ${sequence.sequence}`;
}

/** Inside a Sequence, each unnamed step uses its actual Cue number. */
export function ma2ConsoleCueName(cue: LibrarySequence['cues'][number]): string {
  return consoleName(cue) ?? `Cue ${Number(cue.number)}`;
}

/** The flat material pool needs the owning Sequence to identify an unnamed Cue. */
export function ma2ConsoleCuePoolName(sequence: LibrarySequence, cue: LibrarySequence['cues'][number]): string {
  return consoleName(cue) ?? consoleName(sequence) ?? ma2ConsoleCueName(cue);
}

export function ma2SequenceLibrary(project: LinkProject | null, document: LightingDocument): LibrarySequence[] {
  const catalog = new Map<number, LibrarySequence>();
  const read = project?.ma2ReadState;
  const saved = project?.ma2MaterialLibrary;
  const library = saved?.library && (!read || saved.source === read.source && saved.library.directory.show === read.catalog.directory.show && saved.library.directory.generation === read.catalog.directory.generation) ? saved.library : null;
  // A pool read is authoritative, including an empty or partially read pool.
  // Song references remain in the project, but cannot resurrect deleted objects
  // or objects from a different Show in the console's audition browser.
  const sequences = library ? library.sequences : read ? read.catalog.entries.flatMap(entry => entry.preview?.cueCatalog ?? []) : [
    ...(document.ma2Library?.sequences ?? []),
    ...(project?.rundown.flatMap(item => item.lighting?.ma2Bindings?.flatMap(binding => binding.cueCatalog ?? []) ?? []) ?? []),
    ...(document.ma2Bindings?.flatMap(binding => binding.cueCatalog ?? []) ?? [])
  ];
  for (const sequence of sequences) {
    catalog.set(sequence.sequence, { ...sequence, complete: true, cues: [...sequence.cues].sort((a, b) => a.index - b.index) });
  }
  for (const template of document.templates) {
    if (library || read) break;
    const stamp = template.track.cueStamp;
    if (stamp?.mode !== 'fixed' || catalog.get(stamp.sequence)?.complete) continue;
    const entry = catalog.get(stamp.sequence) ?? { sequence: stamp.sequence, name: null, complete: false, cues: [] };
    if (!entry.cues.some(cue => Number(cue.number) === Number(stamp.cue))) entry.cues.push({ number: stamp.cue, name: template.name });
    entry.cues.sort((a, b) => Number(a.number) - Number(b.number)); catalog.set(stamp.sequence, entry);
  }
  const names=new Map<string,string>();
  const renames = library && saved ? pendingMa2Renames(project).filter(change => change.endpoint === saved.source && change.show === library.directory.show) : [];
  if(project&&saved&&library) for(const entry of projectLightingLibrary(project).entries){
    const ref=entry.track.cueStamp;
    if(ref?.mode==='fixed'&&ref.executor===''&&entry.kind!=='combination'&&entry.name!==entry.originalName&&entry.source.endpoint===saved.source&&entry.source.show===library.directory.show) names.set(consoleCueKey({...ref,kind:entry.kind}),entry.name);
  }
  return [...catalog.values()].sort((a, b) => a.sequence - b.sequence).map(sequence=>{
    const cues=sequence.cues.map(cue=>({...cue,originalName:cue.name,name:names.get(consoleCueKey({sequence:sequence.sequence,cue:cue.number,kind:'single'}))??cue.name, renamedName: renames.find(change => change.kind === 'single' && change.sequence === sequence.sequence && Number(change.cue) === Number(cue.number))?.name}));
    const sequenceName=sequence.cues.flatMap(cue=>names.get(consoleCueKey({sequence:sequence.sequence,cue:cue.number,kind:'sequence'}))??[])[0];
    return {...sequence,originalName:sequence.name,name:sequenceName??(cues.length===1&&cues[0]!.name!==cues[0]!.originalName?cues[0]!.name:sequence.name),renamedName: renames.find(change => change.kind === 'sequence' && change.sequence === sequence.sequence)?.name,cues};
  });
}
