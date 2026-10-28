#include "signal.h"
#include "timecode.h"
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
  unsigned char tc[4];
  timecode_parts(0, 30, 0, tc); assert(tc[0] == 0x60 && tc[1] == 0 && tc[2] == 0 && tc[3] == 0);
  timecode_parts(11820u * 25u, 25, 0, tc); assert(tc[0] == (3 | 0x20) && tc[1] == 17 && tc[2] == 0 && tc[3] == 0);
  timecode_parts(24u * 86400u + 23u, 24, 0, tc); assert(tc[0] == 0 && tc[1] == 0 && tc[2] == 0 && tc[3] == 23);
  timecode_parts(1799, 30, 1, tc); assert(tc[0] == 0x40 && tc[1] == 0 && tc[2] == 59 && tc[3] == 29);
  timecode_parts(1800, 30, 1, tc); assert(tc[0] == 0x40 && tc[1] == 1 && tc[2] == 0 && tc[3] == 2);
  timecode_parts(17982, 30, 1, tc); assert(tc[1] == 10 && tc[2] == 0 && tc[3] == 0);
  timecode_parts(17982u + 1800u, 30, 1, tc); assert(tc[1] == 11 && tc[2] == 0 && tc[3] == 2);
  timecode_parts(2589407u, 30, 1, tc); assert(tc[0] == (23 | 0x40) && tc[1] == 59 && tc[2] == 59 && tc[3] == 29);
  timecode_parts(2589408u, 30, 1, tc); assert(tc[0] == 0x40 && tc[1] == 0 && tc[2] == 0 && tc[3] == 0);
  assert(fabs(timecode_frame_ms(30, 1) - 1001.0 / 30.0) < 1e-12 && timecode_frame_ms(25, 0) == 40.0);
  puts("{\"passed\":true,\"scope\":\"native sample envelope, 2048-point stereo monitor math and timecode labels\"}"); return 0;
}
