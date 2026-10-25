import { useDocumentStore } from '../stores/document-store';
import { useIntegrationStore } from '../stores/integration-store';

/**
 * The window's part of a diagnostic package: the open project's outline, the connections and the integration
 * profile as this window sees them. The main process adds the machine, license, update and log details.
 * `includeMa2` adds the MA2 data this project read from the console, for Cue and pairing problems.
 */
export function diagnosticContext(includeMa2: boolean): Record<string, unknown> {
  const project = useDocumentStore.getState().project;
  const integration = useIntegrationStore.getState();
  return {
    project: project ? { projectId: project.projectId, name: project.name, schemaVersion: project.schemaVersion,
      playbackSource: project.playbackSource, programs: project.rundown.length, assets: project.mediaAssets?.length ?? 0 } : null,
    connections: { obs: integration.obs, midiPorts: integration.midiPorts },
    profile: integration.profile ? { acceptedVersions: integration.profile.acceptedVersions,
      internalPlayer: integration.profile.internalPlayer, midiPortProfiles: integration.profile.midiPortProfiles } : null,
    ...(includeMa2 && project?.ma2ReadState ? { ma2ReadState: project.ma2ReadState } : {})
  };
}
