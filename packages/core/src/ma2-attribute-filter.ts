import type { Ma2AttributeRole, Ma2CueAttributes } from '@tb/schema';
import { classifyMa2Attributes } from './ma2-cue-attributes';

export const ma2FilterRoles = ['intensity', 'position', 'color', 'gobo', 'beam', 'focus', 'shutter', 'shapers', 'control', 'video', 'other', 'effect'] as const satisfies readonly Ma2AttributeRole[];
export type Ma2FilterRole = typeof ma2FilterRoles[number];
export type Ma2AttributeFilter = {
  roles: Ma2FilterRole[];
  mode: 'contains-all' | 'contains-any' | 'only';
  status: 'all' | 'empty' | 'tracking' | 'unread' | 'partial' | 'failed';
};
export const emptyMa2AttributeFilter: Ma2AttributeFilter = { roles: [], mode: 'contains-all', status: 'all' };

/** Evaluate a whole sequence so a zero on one fixture cannot hide another fixture's tracked value. */
export function ma2EmptyCueIndices(sequence: readonly Ma2CueAttributes[]): Set<number> {
  const empty = new Set(sequence.filter(cue => ma2CueAttributeState(cue) === 'empty').map(cue => cue.cueIndex));
  if (sequence.some(cue => cue.unknownChannels || cue.content?.state !== 'complete' || cue.content.tracking === 'unverified')) return empty;
  const channel = (row: NonNullable<Ma2CueAttributes['content']>['rows'][number]) =>
    JSON.stringify([row.fixtureId, row.channelId, row.subfixture, row.attribute, row.valuePart ?? 0]);
  const written = new Set<string>();
  for (const cue of sequence) {
    // An effect can continue on a separate layer even when a base value is zero.
    if (cue.hasEffects) return empty;
    for (const row of cue.content!.rows) written.add(channel(row));
  }
  for (const cue of sequence) {
    const content = cue.content!;
    if (!content.rows.length || content.hasCommands || content.hasPlaybackSettings !== false) continue;
    const zeros = new Set<string>();
    for (const row of content.rows) {
      const layer = row.layers[0];
      if (row.layers.length !== 1 || layer?.path !== 'Value' || Object.keys(layer.properties).length
        || !/^[+-]?0+(?:\.0+)?$/.test(layer.value.trim())) break;
      zeros.add(channel(row));
    }
    if (zeros.size === written.size && content.rows.length === zeros.size) empty.add(cue.cueIndex);
  }
  return empty;
}

export function ma2CueAttributeState(details: Ma2CueAttributes | undefined, failed = false): Exclude<Ma2AttributeFilter['status'], 'all'> | 'complete' | 'commands' {
  if (failed) return 'failed';
  if (!details) return 'unread';
  if (details.content?.state !== 'complete' || classifyMa2Attributes(details).roles.includes('unresolved')) return 'partial';
  if (details.attributes.length || details.hasEffects || details.content.rows.length) return 'complete';
  if (details.content.hasCommands || details.content.hasPlaybackSettings) return 'commands';
  if (details.content.hasPlaybackSettings === undefined) return 'partial';
  if (details.content.tracking === 'unverified') return 'partial';
  return details.content.tracking === 'possible' ? 'tracking' : 'empty';
}

/** Only inspects stored data. No selection is an unrestricted filter, never an empty-Cue query. */
export function matchesMa2AttributeFilter(details: Ma2CueAttributes | undefined, filter: Ma2AttributeFilter, failed = false): boolean {
  if (filter.status !== 'all' && ma2CueAttributeState(details, failed) !== filter.status) return false;
  if (!filter.roles.length) return true;
  if (!details || failed) return false;
  const roles = new Set(classifyMa2Attributes(details).roles.filter((role): role is Ma2FilterRole => ma2FilterRoles.some(value => value === role)));
  if (filter.mode === 'contains-any') return filter.roles.some(role => roles.has(role));
  if (!filter.roles.every(role => roles.has(role))) return false;
  if (filter.mode !== 'only') return true;
  if (ma2CueAttributeState(details, failed) !== 'complete' || details.content?.hasCommands || details.content?.hasPlaybackSettings) return false;
  // Shutter belongs to Beam. Exact matching checks each attribute so another
  // Beam feature (e.g. prism) cannot slip into a shutter-only query.
  if (details.hasEffects && !filter.roles.includes('effect')) return false;
  const groups = new Map(details.groups?.map(group => [group.attribute, group]));
  return details.attributes.every(attribute => {
    const group=groups.get(attribute);
    const attributeRoles=classifyMa2Attributes({attributes:[attribute],groups:group?[group]:[],hasEffects:false}).roles;
    return attributeRoles.some(role=>filter.roles.some(selected=>selected===role));
  });
}
