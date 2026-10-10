import type { LightingDocument, LinkProject } from '@tb/schema';
import { consoleCueKey, projectLightingLibrary } from '@tb/core/link';

export type LibrarySequence = { sequence: number; name: string | null; originalName?: string | null; cues: { number: string; name: string | null; originalName?: string | null }[]; complete: boolean };
export function ma2SequenceLibrary(project: LinkProject | null, document: LightingDocument): LibrarySequence[] {
  const catalog = new Map<number, LibrarySequence>();
  const read = project?.ma2ReadState;
  const saved = project?.ma2MaterialLibrary;
  const library = saved?.library && (!read || saved.source === read.source && saved.library.directory.show === read.catalog.directory.show && saved.library.directory.generation === read.catalog.directory.generation) ? saved.library : null;
  // Referenced sequence directories are shared across songs. The separately read
  // full pool takes precedence; a song's older cue catalog cannot truncate it.
  for (const sequence of [...(document.ma2Library?.sequences ?? []), ...(project?.rundown.flatMap(item => item.lighting?.ma2Bindings?.flatMap(binding => binding.cueCatalog ?? []) ?? []) ?? []), ...(read?.catalog.entries.flatMap(entry => entry.preview?.cueCatalog ?? []) ?? []), ...(document.ma2Bindings?.flatMap(binding => binding.cueCatalog ?? []) ?? []), ...(library?.sequences ?? [])]) {
    catalog.set(sequence.sequence, { ...sequence, complete: true, cues: [...sequence.cues].sort((a, b) => a.index - b.index) });
  }
  for (const template of document.templates) {
    const stamp = template.track.cueStamp;
    if (stamp?.mode !== 'fixed' || catalog.get(stamp.sequence)?.complete) continue;
    const entry = catalog.get(stamp.sequence) ?? { sequence: stamp.sequence, name: null, complete: false, cues: [] };
    if (!entry.cues.some(cue => Number(cue.number) === Number(stamp.cue))) entry.cues.push({ number: stamp.cue, name: template.name });
    entry.cues.sort((a, b) => Number(a.number) - Number(b.number)); catalog.set(stamp.sequence, entry);
  }
  const names=new Map<string,string>();
  if(project&&saved&&library) for(const entry of projectLightingLibrary(project).entries){
    const ref=entry.track.cueStamp;
    if(ref?.mode==='fixed'&&ref.executor===''&&entry.kind!=='combination'&&entry.name!==entry.originalName&&entry.source.endpoint===saved.source&&entry.source.show===library.directory.show) names.set(consoleCueKey({...ref,kind:entry.kind}),entry.name);
  }
  return [...catalog.values()].sort((a, b) => a.sequence - b.sequence).map(sequence=>{
    const cues=sequence.cues.map(cue=>({...cue,originalName:cue.name,name:names.get(consoleCueKey({sequence:sequence.sequence,cue:cue.number,kind:'single'}))??cue.name}));
    const sequenceName=sequence.cues.flatMap(cue=>names.get(consoleCueKey({sequence:sequence.sequence,cue:cue.number,kind:'sequence'}))??[])[0];
    return {...sequence,originalName:sequence.name,name:sequenceName??(cues.length===1&&cues[0]!.name!==cues[0]!.originalName?cues[0]!.name:sequence.name),cues};
  });
}
