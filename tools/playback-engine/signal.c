#include "signal.h"
#include <math.h>

double playback_gain(const PlaybackEnvelope *envelope, uint64_t frame) {
  if (!envelope->frames) return envelope->to;
  if (frame <= envelope->start) return envelope->from;
  double fraction = fmin(1.0, (double)(frame - envelope->start) / envelope->frames);
  return envelope->from + (envelope->to - envelope->from) * fraction;
}

/* Only the telemetry thread runs the FFT. The audio thread merely copies the
 * actual gain-adjusted output samples into a fixed-size monitoring ring. */
void playback_analyze(const int16_t *stereo, double *previous, unsigned char *bins, double *peaks) {
  const double pi = 3.14159265358979323846;
  double real[ANALYSIS_FRAMES], imaginary[ANALYSIS_FRAMES];
  peaks[0] = peaks[1] = 0;
  for (unsigned i = 0; i < ANALYSIS_FRAMES; i++) {
    double left = stereo[i * 2] / 32768.0, right = stereo[i * 2 + 1] / 32768.0;
    peaks[0] = fmax(peaks[0], fabs(left)); peaks[1] = fmax(peaks[1], fabs(right));
    real[i] = (left + right) * 0.5 * (0.5 - 0.5 * cos(2 * pi * i / ANALYSIS_FRAMES));
    imaginary[i] = 0;
  }
  for (unsigned i = 1, j = 0; i < ANALYSIS_FRAMES; i++) {
    unsigned bit = ANALYSIS_FRAMES >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { double temporary = real[i]; real[i] = real[j]; real[j] = temporary; }
  }
  for (unsigned size = 2; size <= ANALYSIS_FRAMES; size <<= 1) {
    double step_real = cos(-2 * pi / size), step_imaginary = sin(-2 * pi / size);
    for (unsigned start = 0; start < ANALYSIS_FRAMES; start += size) {
      double phase_real = 1, phase_imaginary = 0;
      for (unsigned j = 0; j < size / 2; j++) {
        unsigned a = start + j, b = a + size / 2;
        double transformed_real = real[b] * phase_real - imaginary[b] * phase_imaginary;
        double transformed_imaginary = real[b] * phase_imaginary + imaginary[b] * phase_real;
        real[b] = real[a] - transformed_real; imaginary[b] = imaginary[a] - transformed_imaginary;
        real[a] += transformed_real; imaginary[a] += transformed_imaginary;
        double next_real = phase_real * step_real - phase_imaginary * step_imaginary;
        phase_imaginary = phase_real * step_imaginary + phase_imaginary * step_real; phase_real = next_real;
      }
    }
  }
  for (unsigned i = 0; i < ANALYSIS_BINS; i++) {
    double magnitude = hypot(real[i], imaginary[i]) * 4.0 / ANALYSIS_FRAMES;
    previous[i] = previous[i] * 0.8 + magnitude * 0.2;
    double db = 20 * log10(fmax(1e-8, previous[i]));
    bins[i] = (unsigned char)lrint(fmax(0, fmin(255, (db + 100) / 70 * 255)));
  }
}
