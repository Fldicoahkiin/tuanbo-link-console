import type { LinkProject } from '@tb/schema';
import { archiveMa2Project } from './ma2-project-archive';

// One archive covers a burst of edits: a console write does not store the whole project again each time.
const ARCHIVE_INTERVAL_MS = 60000;
let lastArchive: { documentId: number; at: number } | null = null;

/** The project copy taken before writing to the console, shared by songs and names. A failure stops the write. */
export async function archiveBeforeSync(documentId: number, project: LinkProject): Promise<void> {
  if (lastArchive?.documentId === documentId && Date.now() - lastArchive.at < ARCHIVE_INTERVAL_MS) return;
  await archiveMa2Project(documentId, project);
  lastArchive = { documentId, at: Date.now() };
}
