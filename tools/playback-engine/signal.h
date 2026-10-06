#ifndef TBLINK_SIGNAL_H
#define TBLINK_SIGNAL_H
#include <stdint.h>
#define ANALYSIS_FRAMES 2048u
#define ANALYSIS_BINS (ANALYSIS_FRAMES / 2)
typedef struct { double from, to; uint64_t start, frames; } PlaybackEnvelope;
double playback_gain(const PlaybackEnvelope *envelope, uint64_t frame);
void playback_analyze(const int16_t *stereo, double *previous, unsigned char *bins, double *peaks);
#endif
