#ifndef TBLINK_TIMECODE_H
#define TBLINK_TIMECODE_H
#include <stdint.h>
/* MIDI timecode labels. fps is the nominal rate: 24, 25 or 30. drop marks 29.97 drop-frame:
 * 30 nominal frames a second, each 1001/30 ms long, labels 00 and 01 skipped at every minute
 * except each tenth. */
double timecode_frame_ms(unsigned fps, int drop);
/* Hours with the rate code in bits 5-6, minutes, seconds and frames of a frame counted from midnight. */
void timecode_parts(uint64_t frame, unsigned fps, int drop, unsigned char out[4]);
#endif
