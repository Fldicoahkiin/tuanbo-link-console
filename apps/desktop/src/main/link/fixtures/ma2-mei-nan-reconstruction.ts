/** Screenshot transcription, NOT an export from the user's console.
 * Times, executors and Cue numbers are visible in image #2. XML hierarchy,
 * pressed values, fader levels and indices are synthetic test scaffolding.
 * This cannot establish native 3.7.0.5 event semantics or hardware acceptance.
 */
export const meiNanCues = ['1.000', '1.100', '2.000', '3.000', '3.100', '4.000', '4.100', '4.200', '5.000', '6.000', '7.000'];
const times = [3, 52, 237, 438, 562, 595, 751, 776, 882, 896, 955];
const learnTimes = [304, 312, 314, 331, 346, 353, 374, 386, 391];
const object = (page: number, executor: number): string => `<Object name="Screenshot reconstruction"><No>30</No><No>1</No><No>${page}</No><No>${executor}</No></Object>`;
export const meiNanXml = `<?xml version="1.0" encoding="utf-8"?>
<MA xmlns="http://schemas.malighting.de/grandma2/xml/MA" major_vers="3" minor_vers="7" stream_vers="0">
<Timecode index="1" name="mei-nan" offset="14400" frame_format="30 FPS" slot="TC Slot 2">
<Track index="0" active="true">${object(2, 14)}<SubTrack index="0" fader_command="Master"><Event index="0" time="0" fader_level="0"/><Event index="1" time="59" fader_level="1"/></SubTrack></Track>
<Track index="1" active="true">${object(51, 101)}<SubTrack index="0">${times.map((time, index) => `<Event index="${index}" time="${time}" command="Goto" pressed="true"><Cue name="Cue ${meiNanCues[index]}"><No>1</No><No>36</No><No>${index + 1}</No></Cue></Event>`).join('')}</SubTrack><SubTrack index="1" fader_command="Master"><Event index="0" time="0" fader_level="1"/></SubTrack></Track>
<Track index="2" active="true">${object(3, 6)}<SubTrack index="0"><Event index="0" time="304" command="Manual XFade Start Temp" pressed="true"/>${learnTimes.map((time, index) => `<Event index="${index + 1}" time="${time}" command="Learn" pressed="true"/>`).join('')}</SubTrack></Track>
</Timecode></MA>`;
export const meiNanSequences = [{ version: '3.7.0', sequences: [{ number: 36, name: 'Screenshot reconstruction', cues: meiNanCues.map((number, index) => ({ index: index + 1, number, name: `Cue ${number}` })) }] }];
