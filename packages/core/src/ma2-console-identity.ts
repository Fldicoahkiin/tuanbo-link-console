import type { LightingDocument, LinkProject, Ma2ObjectDirectory } from '@tb/schema';

/** Where the project last read the console: its address and the name its Show was saved under. */
export type Ma2ConsolePlace = { endpoint: string; show: string };

/**
 * The console is known by its object numbers, not by the Show's file name or the address it is
 * reached at (2026-10-30). Saving the Show under a new name, or reaching the console at another IP,
 * moves every console reference in the project to the new place, so nothing has to be bound again.
 *
 * A song's own Sequence (way 2) moves only while the console still has that Sequence under the
 * name the song wrote, or no longer has it at all (the next sync rebuilds it there). Another name at
 * that number means another Show is open; the song keeps its old place, and its sync says so.
 */
export function retargetMa2References(project: LinkProject, from: Ma2ConsolePlace, to: Ma2ConsolePlace, sequences: Ma2ObjectDirectory['entries']): LinkProject {
  if (from.endpoint === to.endpoint && from.show === to.show) return project;
  const same = (place: { endpoint: string; show: string }): boolean => place.endpoint === from.endpoint && place.show === from.show;
  const moved = <T extends { endpoint: string; show: string }>(place: T): T => same(place) ? { ...place, endpoint: to.endpoint, show: to.show } : place;
  const consoleName = new Map(sequences.map(entry => [entry.target, entry.name]));
  const lighting = (document: LightingDocument): LightingDocument => {
    const song = document.consoleSong;
    const songMoves = song !== undefined && same(song) && (!consoleName.has(song.sequence) || consoleName.get(song.sequence) === song.name);
    const kept = document.fixtureCategories?.filter(entry => entry.show === to.show).map(entry => entry.category) ?? [];
    return {
      ...document,
      ...(song && songMoves ? { consoleSong: { ...song, endpoint: to.endpoint, show: to.show } } : {}),
      ...(document.ma2Library?.show === from.show ? { ma2Library: { ...document.ma2Library, show: to.show } } : {}),
      ...(document.fixtureCategories ? { fixtureCategories: document.fixtureCategories.flatMap(entry => entry.show !== from.show ? [entry]
        : kept.includes(entry.category) ? [] : [{ ...entry, show: to.show }]) } : {}),
      templates: document.templates.map(template => template.sourceShow === from.show ? { ...template, sourceShow: to.show } : template)
    };
  };
  const material = project.ma2MaterialLibrary;
  const user = material?.userLibrary;
  return {
    ...project,
    rundown: project.rundown.map(item => item.lighting ? { ...item, lighting: lighting(item.lighting) } : item),
    ...(material && user ? { ma2MaterialLibrary: { ...material, userLibrary: {
      ...user,
      entries: user.entries.map(entry => same(entry.source) ? { ...entry, source: moved(entry.source) } : entry),
      ...(user.consoleRenames ? { consoleRenames: user.consoleRenames.map(moved) } : {}),
      ...(user.hiddenConsoleCues ? { hiddenConsoleCues: user.hiddenConsoleCues.map(moved) } : {})
    } } } : {})
  };
}

/** The place a saved material library was read from, or null when the project never read a console. */
export function ma2MaterialPlace(project: LinkProject): Ma2ConsolePlace | null {
  const material = project.ma2MaterialLibrary;
  if (!material?.library || material.source.startsWith('project:')) return null;
  return { endpoint: material.source, show: material.library.directory.show };
}
