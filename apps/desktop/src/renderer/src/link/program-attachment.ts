import type { LinkProject } from '@tb/schema';

/**
 * What a window knows of the background program its page opened (useInternalPlayer, 0.5.9 S7, S8a). Every event of
 * the program names the newest version it holds (NativeProgramEvent.documentVersion) and the version the held song's
 * picture follows (pictureVersion, the one the song started with); the page remembers the versions it sent
 * (ProgramDocumentFeed), so it knows both projects exactly. After a window reload the program may hold a song started
 * with a version this page never had: the window says the picture plays another version until that song stops.
 */

/** The page's player as far as this goes: whether its open was answered, the newest version the program holds and the
 * version the picture of the song on stage follows. */
export type ProgramController = { readonly attached: boolean; readonly project: LinkProject | null; readonly pictureProject: LinkProject | null };

/**
 * `outdated`: whether the picture on air follows a version this page did not send; null until the program answered the
 * open and named its versions, and when there is no controller. `project`: the newest version the program holds, when
 * known. `pictureProject`: the version the picture of the song on stage follows, when known. `programVersion` is the
 * pair of versions last named and `attachments` how many opens were answered: they only make the window read the
 * controller again.
 */
export function programPlays(controller: ProgramController | null, programVersion: string | null, attachments: number): { outdated: boolean | null; project: LinkProject | null; pictureProject: LinkProject | null } {
  if (!controller || !controller.attached || programVersion === null || attachments === 0) return { outdated: null, project: null, pictureProject: null };
  const project = controller.project, pictureProject = controller.pictureProject;
  return { outdated: pictureProject === null, project, pictureProject };
}
