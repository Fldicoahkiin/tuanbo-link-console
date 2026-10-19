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
  const state = ma2CueAttributeState(details, failed);
  if (filter.status !== 'all' && state !== filter.status) return false;
  if (!filter.roles.length) return true;
  if (!details || failed) return false;
  const roles = new Set(classifyMa2Attributes(details).roles.filter((role): role is Ma2FilterRole => ma2FilterRoles.some(value => value === role)));
  if (filter.mode === 'contains-any') return filter.roles.some(role => roles.has(role));
  if (!filter.roles.every(role => roles.has(role))) return false;
  if (filter.mode !== 'only') return true;
  if (state !== 'complete' || details.content?.hasCommands || details.content?.hasPlaybackSettings) return false;
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
