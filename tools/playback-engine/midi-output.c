#include "engine.h"
#include <fcntl.h>
#include <io.h>
#include <string.h>

// Separate non-realtime process: driver RPC/SysEx must never block the WASAPI
// clock or MTC worker. Exactly one explicitly named output per process.
static HMIDIOUT output;
static HANDLE completed;
static MIDIHDR pending_header;
static unsigned char pending_bytes[65536];
static BOOL notes[16][128];
static LARGE_INTEGER counter_frequency;

static UINT32 packet_u32(const unsigned char *bytes) { UINT32 value; memcpy(&value, bytes, 4); return value; }
static UINT64 packet_u64(const unsigned char *bytes) { UINT64 value; memcpy(&value, bytes, 8); return value; }
static UINT64 now_100ns(void) {
  LARGE_INTEGER now; QueryPerformanceCounter(&now);
  return (UINT64)((double)now.QuadPart * 10000000.0 / counter_frequency.QuadPart);
}
static void reply(UINT32 request, int32_t code) {
  printf("{\"version\":1,\"requestId\":%u,\"code\":%d,\"acceptedAt100ns\":\"%llu\"}\n",
    request, code, (unsigned long long)(code == 0 ? now_100ns() : 0));
  fflush(stdout);
}
static int32_t open_output(const unsigned char *bytes, UINT32 length) {
  if (output || !length || length > 1024 || memchr(bytes, 0, length)) return -1;
  wchar_t name[257];
  int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char *)bytes, (int)length, name, 256);
  if (size <= 0) return -1;
  name[size] = 0;
  UINT count = midiOutGetNumDevs(), found = 0, index = 0;
  for (UINT i = 0; i < count; i++) {
    MIDIOUTCAPSW caps;
    MMRESULT result = midiOutGetDevCapsW(i, &caps, sizeof(caps));
    if (result) return (int32_t)result;
    if (wcscmp(name, caps.szPname) == 0) { index = i; found++; }
  }
  if (found != 1) return found ? -3 : -2;
  completed = CreateEventW(NULL, FALSE, FALSE, NULL);
  if (!completed) return -4;
  MMRESULT result = midiOutOpen(&output, index, (DWORD_PTR)completed, 0, CALLBACK_EVENT);
  if (result) return (int32_t)result;
  // Recheck the opened handle, not an index which can change during hot-plug.
  MIDIOUTCAPSW actual;
  result = midiOutGetDevCapsW((UINT_PTR)output, &actual, sizeof(actual));
  if (result) return (int32_t)result;
  if (wcscmp(name, actual.szPname) != 0) return -5;
  return 0;
}
static BOOL valid_message(const unsigned char *bytes, UINT32 length) {
  if (!length || length > sizeof(pending_bytes)) return FALSE;
  unsigned status = bytes[0], type = status & 0xf0;
  if (status == 0xf0) {
    if (length < 3 || bytes[length - 1] != 0xf7) return FALSE;
    for (UINT32 i = 1; i + 1 < length; i++) if (bytes[i] >= 128) return FALSE;
    return TRUE;
  }
  // MTC quarter frame: timecode for the editor's lighting preview.
  if (status == 0xf1) return length == 2 && bytes[1] < 128;
  if (type < 0x80 || type > 0xe0 || length != (type == 0xc0 || type == 0xd0 ? 2u : 3u)) return FALSE;
  for (UINT32 i = 1; i < length; i++) if (bytes[i] >= 128) return FALSE;
  return TRUE;
}
static int32_t finish_buffer(UINT64 deadline) {
  if (!(pending_header.dwFlags & MHDR_PREPARED)) return 0;
  while (pending_header.dwFlags & MHDR_INQUEUE) {
    UINT64 now = now_100ns();
    if (now >= deadline) return -6;
    DWORD wait_ms = (DWORD)((deadline - now + 9999) / 10000);
    DWORD result = WaitForSingleObject(completed, wait_ms);
    if (result == WAIT_FAILED) return -4;
    if (result == WAIT_TIMEOUT && (pending_header.dwFlags & MHDR_INQUEUE)) return -6;
  }
  MMRESULT result = midiOutUnprepareHeader(output, &pending_header, sizeof(pending_header));
  if (!result) memset(&pending_header, 0, sizeof(pending_header));
  return (int32_t)result;
}
static int32_t send_message(const unsigned char *bytes, UINT32 length, UINT64 deadline) {
  if (!output || !valid_message(bytes, length) || !deadline) return -1;
  UINT64 now = now_100ns();
  if (deadline <= now) return -7;
  if (deadline - now > 20000000u) return -1;
  int32_t result = finish_buffer(deadline);
  if (result) return result;
  if (now_100ns() >= deadline) return -7;
  if (bytes[0] == 0xf0) {
    memcpy(pending_bytes, bytes, length);
    pending_header.lpData = (LPSTR)pending_bytes; pending_header.dwBufferLength = length;
    MMRESULT prepared = midiOutPrepareHeader(output, &pending_header, sizeof(pending_header));
    if (prepared) return (int32_t)prepared;
    if (now_100ns() >= deadline) return -7;
    ResetEvent(completed);
    return (int32_t)midiOutLongMsg(output, &pending_header, sizeof(pending_header));
  }
  DWORD message = bytes[0] | ((DWORD)bytes[1] << 8) | (length == 3 ? (DWORD)bytes[2] << 16 : 0);
  MMRESULT sent = midiOutShortMsg(output, message);
  if (!sent && (bytes[0] & 0xf0) == 0x90) notes[bytes[0] & 15][bytes[1]] = bytes[2] != 0;
  else if (!sent && (bytes[0] & 0xf0) == 0x80) notes[bytes[0] & 15][bytes[1]] = FALSE;
  return (int32_t)sent;
}
static int close_output(void) {
  int failed = 0;
  if (output) {
    int32_t result = finish_buffer(now_100ns() + 20000000u);
    if (pending_header.dwFlags & MHDR_INQUEUE) {
      // Do not reset the whole endpoint or free a buffer still owned by its
      // driver. The parent reports incomplete close and retains this process.
      fprintf(stderr, "MIDI output buffer still pending during close\n"); fflush(stderr);
      while (pending_header.dwFlags & MHDR_INQUEUE) {
        if (WaitForSingleObject(completed, 1000) == WAIT_FAILED) {
          // An invalid wait handle is not evidence that the driver released
          // its buffer. Retain storage until MHDR_INQUEUE actually clears.
          if (!failed) { fprintf(stderr, "MIDI completion wait failed; retaining buffer\n"); fflush(stderr); }
          failed = 1; Sleep(10);
        }
      }
      result = finish_buffer(now_100ns() + 20000000u);
    }
    if (result) { fprintf(stderr, "MIDI buffer release failed: %d\n", result); failed = 1; }
    for (unsigned channel = 0; channel < 16; channel++) for (unsigned note = 0; note < 128; note++) {
      if (notes[channel][note] && midiOutShortMsg(output, 0x80u + channel + (note << 8))) failed = 1;
    }
    MMRESULT closed = midiOutClose(output);
    if (closed) { fprintf(stderr, "MIDI output close failed: %u\n", closed); failed = 1; }
  }
  if (completed) CloseHandle(completed);
  return failed;
}
int serve_midi_output(void) {
  _setmode(_fileno(stdin), _O_BINARY); QueryPerformanceFrequency(&counter_frequency);
  unsigned char header[24], payload[65536]; UINT32 previous = 0;
  int failed = 0;
  for (;;) {
    size_t size = fread(header, 1, sizeof(header), stdin);
    if (!size && feof(stdin)) break;
    UINT32 request = size == sizeof(header) ? packet_u32(header + 4) : 0;
    if (size != sizeof(header) || memcmp(header, "TBM1", 4) || !request || request <= previous) { failed = 1; break; }
    previous = request;
    UINT32 operation = packet_u32(header + 8), length = packet_u32(header + 12);
    UINT64 deadline = packet_u64(header + 16);
    if (length > sizeof(payload) || !length || (operation != 1 && operation != 2) || (operation == 1 && deadline)) { failed = 1; break; }
    if (fread(payload, 1, length, stdin) != length) { failed = 1; break; }
    int32_t code = operation == 1 ? open_output(payload, length) : send_message(payload, length, deadline);
    reply(request, code);
    // Only this message (2026-11-10): expired (-7), the previous SysEx still sending (-6) or invalid (-1) on an
    // open port; the parent decides what follows and the next message is read. Anything else, a failed open
    // or a send without an open port ends the process.
    if (code && (operation == 1 || !output || (code != -7 && code != -6 && code != -1))) { failed = 1; break; }
  }
  if (close_output()) failed = 1;
  return failed ? 3 : 0;
}
