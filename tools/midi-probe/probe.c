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

// Do not start another WinMM RPC while the new Windows MIDI service is
// draining existing clients. Older Windows installations have no midisrv.
static int service_stopping(void) {
  SC_HANDLE manager = OpenSCManagerW(NULL, NULL, SC_MANAGER_CONNECT);
  if (!manager) return -1;
  SC_HANDLE service = OpenServiceW(manager, L"midisrv", SERVICE_QUERY_STATUS);
  DWORD error = service ? ERROR_SUCCESS : GetLastError();
  CloseServiceHandle(manager);
  if (!service) return error == ERROR_SERVICE_DOES_NOT_EXIST ? 0 : -1;
  SERVICE_STATUS_PROCESS status = {0}; DWORD needed = 0;
  BOOL read = QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO, (BYTE *)&status, sizeof(status), &needed);
  CloseServiceHandle(service);
  return !read ? -1 : status.dwCurrentState == SERVICE_STOP_PENDING ? 1 : 0;
}

int main(void) {
  int stopping = service_stopping();
  if (stopping != 0) {
    printf("%s\n", stopping > 0 ? "stopping" : "failed");
    return 2;
  }
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
