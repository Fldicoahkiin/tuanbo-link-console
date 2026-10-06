#include "signal.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

int main(void) {
  PlaybackEnvelope envelope = { 0.2, 0.8, 480000, 48000 };
  assert(playback_gain(&envelope, 479000) == 0.2);
  assert(fabs(playback_gain(&envelope, 504000) - 0.5) < 1e-12);
  assert(fabs(playback_gain(&envelope, 528000) - 0.8) < 1e-12);
  assert(fabs(playback_gain(&envelope, UINT64_MAX) - 0.8) < 1e-12);
  envelope = (PlaybackEnvelope){ 0.8, 0, 528000, 48000 };
  assert(fabs(playback_gain(&envelope, 552000) - 0.4) < 1e-12);
  assert(playback_gain(&envelope, 576000) == 0);
  envelope.frames = 0; assert(playback_gain(&envelope, 0) == 0);
  int16_t stereo[ANALYSIS_FRAMES * 2]; double previous[ANALYSIS_BINS] = {0}, peaks[2]; unsigned char bins[ANALYSIS_BINS];
  memset(stereo, 0, sizeof(stereo)); playback_analyze(stereo, previous, bins, peaks);
  assert(peaks[0] == 0 && peaks[1] == 0);
  for (unsigned i = 0; i < ANALYSIS_BINS; i++) assert(bins[i] == 0);
  for (unsigned i = 0; i < ANALYSIS_FRAMES; i++) {
    double wave = sin(i * 64 * 2 * 3.14159265358979323846 / ANALYSIS_FRAMES);
    stereo[i * 2] = (int16_t)lrint(wave * 1638); stereo[i * 2 + 1] = (int16_t)lrint(wave * 819);
  }
  playback_analyze(stereo, previous, bins, peaks);
  assert(fabs(peaks[0] - 0.05) < 0.0001 && fabs(peaks[1] - 0.025) < 0.0001);
  for (unsigned i = 0; i < ANALYSIS_BINS; i++) if (i != 64) assert(bins[i] < bins[64]);
  assert(bins[64] > 200);
  puts("{\"passed\":true,\"scope\":\"native sample envelope and 2048-point stereo monitor math\"}"); return 0;
}
