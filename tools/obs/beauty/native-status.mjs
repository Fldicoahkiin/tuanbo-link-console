import assert from 'node:assert/strict';

export function nativeStatus(logs, channel, startedAt, endedAt) {
  const start = Date.parse(startedAt), end = Date.parse(endedAt);
  assert(Number.isFinite(start) && Number.isFinite(end) && end >= start, 'Invalid native observation window');
  const events = [];
  const unfiltered = logs.length > 0 && logs.every(log => /Command Line Arguments:[^\r\n]*--unfiltered_log(?:\s|$)/m.test(log.text));
  const suppressedLines = logs.reduce((total,log) => total + [...log.text.matchAll(/Last log entry repeated for (\d+) more lines/g)].reduce((sum,match) => sum + Number(match[1]),0),0);
  for (const { name, text } of logs) {
    const date = /^(\d{4})-(\d{2})-(\d{2}) /.exec(name);
    assert(date, 'OBS log filename has no date');
    let day = Number(date[3]), previous = -1;
    for (const line of text.split(/\r?\n/)) {
      const clock = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3}):/.exec(line);
      if (!clock) continue;
      const [, hour, minute, second, millisecond] = clock.map(Number);
      const clockMs = ((hour * 60 + minute) * 60 + second) * 1000 + millisecond;
      if (previous - clockMs > 12 * 60 * 60 * 1000) day++;
      previous = clockMs;
      const match = /\[tblink-beauty\] channel=(\S+) live status=(\d+) faces=(\d+) profiles=(\d+) accepted=(\d+) age_ms=(\d+)/.exec(line);
      if (!match || match[1] !== channel) continue;
      const at = new Date(Number(date[1]), Number(date[2]) - 1, day, hour, minute, second, millisecond).getTime();
      events.push({ at, status: Number(match[2]), faces: Number(match[3]), profiles: Number(match[4]),
        accepted: Number(match[5]), ageMs: Number(match[6]) });
    }
  }
  events.sort((a, b) => a.at - b.at);
  const first = events.find(event => event.at <= end && event.accepted > 0 && (event.status === 1 || event.status === 2));
  assert(first, 'No native accepted transition for the measured source');
  const measured = events.filter(event => event.at >= Math.max(start, first.at) && event.at <= end);
  const initial = events.filter(event => event.at >= first.at && event.at < start).at(-1);
  const expiredAtStart = initial?.status === 3;
  return { channel, startedAt, endedAt, firstAcceptedAt: new Date(first.at).toISOString(),
    complete: unfiltered && suppressedLines === 0, unfiltered, suppressedLines,
    transitions: measured, expiredAtStart,
    expiredTransitions: measured.filter(event => event.status === 3).length + Number(expiredAtStart),
    scope: 'Native per-render state transitions for this source within the measured interval; excludes startup before first acceptance and shutdown after measurement.' };
}
