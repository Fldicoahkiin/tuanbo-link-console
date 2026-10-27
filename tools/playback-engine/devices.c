#include "engine.h"
#include <functiondiscoverykeys_devpkey.h>
#include <string.h>
#include <io.h>
#include <fcntl.h>

static void json_string(const wchar_t *value) {
  char utf8[8192];
  int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, utf8, sizeof(utf8), NULL, NULL);
  if (!count) { fputs("null", stdout); return; }
  putchar('"');
  for (int i = 0; i < count - 1; i++) {
    unsigned char c = (unsigned char)utf8[i];
    if (c == '"' || c == '\\') { putchar('\\'); putchar(c); }
    else if (c < 32) printf("\\u%04x", c);
    else putchar(c);
  }
  putchar('"');
}

static int write_devices(bool include_midi) {
  HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
  if (FAILED(hr)) return 2;
  IMMDeviceEnumerator *enumerator = NULL;
  IMMDeviceCollection *collection = NULL;
  IMMDevice *default_device = NULL;
  wchar_t *default_id = NULL;
  hr = CoCreateInstance(&CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL, &IID_IMMDeviceEnumerator, (void **)&enumerator);
  if (SUCCEEDED(hr)) {
    HRESULT found = IMMDeviceEnumerator_GetDefaultAudioEndpoint(enumerator, eRender, eMultimedia, &default_device);
    if (SUCCEEDED(found)) hr = IMMDevice_GetId(default_device, &default_id);
    else if (found != HRESULT_FROM_WIN32(ERROR_NOT_FOUND)) hr = found;
  }
  if (SUCCEEDED(hr)) hr = IMMDeviceEnumerator_EnumAudioEndpoints(enumerator, eRender, DEVICE_STATE_ACTIVE, &collection);
  UINT count = 0;
  if (SUCCEEDED(hr)) hr = IMMDeviceCollection_GetCount(collection, &count);
  if (SUCCEEDED(hr) && count > 256) hr = E_INVALIDARG;
  fputs("{\"protocol\":4,\"audio\":[", stdout);
  for (UINT i = 0; SUCCEEDED(hr) && i < count; i++) {
    IMMDevice *device = NULL;
    IPropertyStore *properties = NULL;
    wchar_t *id = NULL;
    PROPVARIANT name; PropVariantInit(&name);
    hr = IMMDeviceCollection_Item(collection, i, &device);
    if (SUCCEEDED(hr)) hr = IMMDevice_GetId(device, &id);
    if (SUCCEEDED(hr)) hr = IMMDevice_OpenPropertyStore(device, STGM_READ, &properties);
    if (SUCCEEDED(hr)) hr = IPropertyStore_GetValue(properties, &PKEY_Device_FriendlyName, &name);
    if (SUCCEEDED(hr) && (name.vt != VT_LPWSTR || !name.pwszVal)) hr = E_INVALIDARG;
    if (SUCCEEDED(hr)) {
      if (i) putchar(',');
      fputs("{\"id\":", stdout); json_string(id);
      fputs(",\"name\":", stdout); json_string(name.pwszVal);
      printf(",\"isDefault\":%s}", default_id && wcscmp(default_id, id) == 0 ? "true" : "false");
    }
    PropVariantClear(&name);
    if (id) CoTaskMemFree(id);
    if (properties) IPropertyStore_Release(properties);
    if (device) IMMDevice_Release(device);
  }
  fputs("],\"midiOutputs\":[", stdout);
  UINT midi_count = include_midi ? midiOutGetNumDevs() : 0;
  for (UINT i = 0; SUCCEEDED(hr) && i < midi_count; i++) {
    MIDIOUTCAPSW caps;
    MMRESULT result = midiOutGetDevCapsW(i, &caps, sizeof(caps));
    if (result != MMSYSERR_NOERROR) { hr = E_FAIL; break; }
    if (i) putchar(',');
    printf("{\"id\":%u,\"name\":", i); json_string(caps.szPname); putchar('}');
  }
  fputs("],\"midiInputs\":[", stdout);
  UINT input_count = include_midi && SUCCEEDED(hr) ? midiInGetNumDevs() : 0;
  for (UINT i = 0; SUCCEEDED(hr) && i < input_count; i++) {
    MIDIINCAPSW caps;
    MMRESULT result = midiInGetDevCapsW(i, &caps, sizeof(caps));
    if (result != MMSYSERR_NOERROR) { hr = E_FAIL; break; }
    if (i) putchar(',');
    printf("{\"id\":%u,\"name\":", i); json_string(caps.szPname); putchar('}');
  }
  fputs("]}", stdout);
  if (default_id) CoTaskMemFree(default_id);
  if (default_device) IMMDevice_Release(default_device);
  if (collection) IMMDeviceCollection_Release(collection);
  if (enumerator) IMMDeviceEnumerator_Release(enumerator);
  CoUninitialize();
  if (FAILED(hr)) fprintf(stderr, "Device enumeration failed: %ld\n", (long)hr);
  return FAILED(hr) ? 3 : 0;
}

int print_devices(void) {
  int result = write_devices(true);
  putchar('\n'); fflush(stdout);
  return result;
}

// A dedicated non-realtime process keeps driver initialization warm. Every
// request still enumerates current endpoints; no device inventory is cached.
int serve_devices(bool include_midi) {
  _setmode(_fileno(stdin), _O_BINARY);
  unsigned char request[8];
  for (;;) {
    size_t count = fread(request, 1, sizeof(request), stdin);
    if (!count && feof(stdin)) return 0;
    if (count != sizeof(request) || memcmp(request, "TBD1", 4) != 0) return 2;
    UINT32 id = (UINT32)request[4] | ((UINT32)request[5] << 8) | ((UINT32)request[6] << 16) | ((UINT32)request[7] << 24);
    if (!id) return 2;
    printf("{\"version\":1,\"requestId\":%u,\"devices\":", id);
    int result = write_devices(include_midi);
    printf(",\"ok\":%s}\n", result ? "false" : "true"); fflush(stdout);
    if (result) return result;
  }
}
