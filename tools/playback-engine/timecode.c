#include "timecode.h"
#include <float.h>
#include <math.h>

double timecode_frame_ms(unsigned fps, int drop) { return drop ? 1001.0 / 30.0 : 1000.0 / fps; }

double timecode_frame_position(double origin_ms, double audio_ms, unsigned fps, int drop) {
  const double numerator = drop ? 30000.0 : fps, denominator = drop ? 1001000.0 : 1000.0;
  double origin = origin_ms * numerator / denominator;
  // The project stores a selected timecode frame as whole milliseconds. Restore that
  // frame only when it round-trips; keep arbitrary millisecond origins as supplied.
  double selected = round(origin);
  if (round(selected * denominator / numerator) == origin_ms) origin = selected;
  double frames = origin + audio_ms * numerator / denominator;
  double nearest_quarter = round(frames * 4.0) / 4.0;
  // Floating-point error at a boundary is smaller than any WASAPI clock tick.
  return fabs(frames - nearest_quarter) <= 4.0 * DBL_EPSILON * fmax(1.0, frames) ? nearest_quarter : frames;
}

void timecode_parts(uint64_t frame, unsigned fps, int drop, unsigned char out[4]) {
  // A day of drop-frame holds 2 589 408 frames: 24 h x 6 blocks of 17 982.
  frame %= drop ? 2589408u : (uint64_t)fps * 86400u;
  if (drop) {
    uint64_t blocks = frame / 17982u, rest = frame % 17982u;
    frame += 18u * blocks + (rest >= 2 ? 2u * ((rest - 2u) / 1798u) : 0u);
  }
  out[3] = (unsigned char)(frame % fps); frame /= fps;
  out[2] = (unsigned char)(frame % 60); frame /= 60;
  out[1] = (unsigned char)(frame % 60); frame /= 60;
  out[0] = (unsigned char)((frame % 24) | ((fps == 24 ? 0 : fps == 25 ? 1 : drop ? 2 : 3) << 5));
}
