import type { LinkProject } from '@tb/schema';

/**
 * What a window knows of the background program its page opened (useInternalPlayer, 0.5.9 S7). Every event of the
 * program names the version it plays (NativeProgramEvent.documentVersion); the page remembers the versions it sent
 * (ProgramDocumentFeed), so it knows the project on air exactly. After a window reload the program may have kept
 * playing a version this page never had: the window says it plays another version, and the program takes the page's
 * version once the song stops (NativeProgramService keeps it pending).
 */

/** The page's player as far as this goes: whether its open was answered, and the project of the version on air. */
export type ProgramController = { readonly attached: boolean; readonly project: LinkProject | null };

/**
 * `outdated`: whether the program plays a version this page did not send; null until the program answered the open
 * and named the version it plays, and when there is no controller. `project`: the project on air when known.
 * `attachments` is how many opens were answered: it only makes the window read the controller again.
 */
export function programPlays(controller: ProgramController | null, programVersion: string | null, attachments: number): { outdated: boolean | null; project: LinkProject | null } {
  if (!controller || !controller.attached || programVersion === null || attachments === 0) return { outdated: null, project: null };
  const project = controller.project;
  return project ? { outdated: false, project } : { outdated: true, project: null };
}
