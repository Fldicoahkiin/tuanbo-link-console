#include "timecode.h"

double timecode_frame_ms(unsigned fps, int drop) { return drop ? 1001.0 / 30.0 : 1000.0 / fps; }

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
