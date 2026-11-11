import { requiredSchemaVersion, type LinkProject } from '@tb/schema';

/** Every command that adds data goes through here instead of writing a version by hand.
 * Only raises, never lowers: a newer file stays newer after any edit, so an older release keeps refusing it
 * rather than silently dropping what it does not understand. A project that needs no more than it has keeps its version. */
export function withSchemaVersion(project: LinkProject): LinkProject {
  const required = requiredSchemaVersion(project);
  return project.schemaVersion >= required ? project : { ...project, schemaVersion: required };
}
