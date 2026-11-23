import type { SaxesTagNS } from 'saxes';

export function cueChannelSummary() {
  const fixtureIds = new Set<number>();
  const attributes = new Set<string>();
  let unknownChannels = 0;
  let invalidFixture = false;
  return {
    add(fixture: string | null, channel: string | null, attribute: string | null) {
      if (attribute?.trim()) attributes.add(attribute); else unknownChannels++;
      if (fixture && /^[1-9]\d*$/.test(fixture) && Number.isSafeInteger(Number(fixture))) fixtureIds.add(Number(fixture));
      else {
        if (fixture) invalidFixture = true;
        if (!/^[1-9]\d*$/.test(channel ?? '')) unknownChannels++;
      }
    },
    finish() {
      return { fixtureIds: [...fixtureIds].sort((a, b) => a - b), attributes: [...attributes].sort(), unknownChannels, invalidFixture };
    }
  };
}

/** Build the material catalogue during the same validated pass that indexes native fixture payloads. */
export function nativeSequenceChannels(namespace: string) {
  const values: Array<ReturnType<ReturnType<typeof cueChannelSummary>['finish']> & {
    sequence: number; cueIndex: number; nil: boolean; hasEffects: boolean;
  }> = [];
  let depth = 0;
  let sequence: number | undefined;
  let cue: ReturnType<typeof cueChannelSummary> | undefined;
  let cueIndex = 0;
  let nil = false;
  let hasEffects = false;
  const channelChild: boolean[] = [], effectDescendant: boolean[] = [];
  return {
    values,
    open(tag: SaxesTagNS) {
      depth++;
      const native = tag.uri === namespace;
      if (depth === 2 && native && tag.local === 'Sequ') sequence = Number(tag.attributes.index?.value) + 1;
      if (depth === 3 && sequence !== undefined && native && tag.local === 'Cue' && tag.attributes.index) {
        cue = cueChannelSummary();
        cueIndex = Number(tag.attributes.index.value);
        nil = Object.values(tag.attributes).some(a => a.uri === 'http://www.w3.org/2001/XMLSchema-instance' && a.local === 'nil' && a.value === 'true');
        hasEffects = false;
      }
      if (!cue) return;
      channelChild[depth] = false;
      effectDescendant[depth] = false;
      if (native && tag.local === 'Channel') {
        channelChild[depth - 1] = true;
        cue.add(tag.attributes.fixture_id?.value ?? null, tag.attributes.channel_id?.value ?? null, tag.attributes.attribute_name?.value ?? null);
      } else if (native && tag.local === 'Effect') effectDescendant[depth - 1] = true;
    },
    close() {
      if (cue) {
        if (channelChild[depth] && effectDescendant[depth]) hasEffects = true;
        if (effectDescendant[depth]) effectDescendant[depth - 1] = true;
        if (depth === 3) {
          values.push({ sequence: sequence!, cueIndex, nil, hasEffects, ...cue.finish() });
          cue = undefined;
        }
      }
      if (depth === 2) sequence = undefined;
      depth--;
    }
  };
}
