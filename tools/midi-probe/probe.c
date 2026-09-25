#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmsystem.h>
#include <stdio.h>

// Never enumerate a potentially stalled MIDI driver in the desktop process.
// This disposable probe owns no ports, user files, or external applications.
static DWORD WINAPI enumerate_devices(void *unused) {
  (void)unused;
  midiInGetNumDevs();
  midiOutGetNumDevs();
  return 0;
}

int main(void) {
  HANDLE worker = CreateThread(NULL, 0, enumerate_devices, NULL, 0, NULL);
  DWORD status = worker ? WaitForSingleObject(worker, 1500) : WAIT_FAILED;
  const char *result = status == WAIT_OBJECT_0 ? "ready" : status == WAIT_TIMEOUT ? "timeout" : "failed";
  printf("%s\n", result);
  fflush(stdout);
  if (worker) CloseHandle(worker);
  // Self-termination bounds a blocked system RPC, including during app shutdown.
  // No driver handle was opened and no other process is terminated.
  ExitProcess(status == WAIT_OBJECT_0 ? 0 : 2);
}
