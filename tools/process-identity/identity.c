// Reads who a process is when this console may not open it fully, for example OBS
// started as administrator: image path, creation time and command line. It asks only
// for PROCESS_QUERY_LIMITED_INFORMATION and changes nothing in the target process.
// Usage: tblink-process-identity.exe <pid> [<pid> ...] | --tcp <local port> [<local port>]
// Output: one UTF-8 JSON array; per pid either
//   {"pid":1,"path":"C:\\...","creationTime":"<FILETIME>","commandLine":"..."|null,"handleCount":<n>|null}
//   {"pid":1,"error":<Win32 error>}
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_PIDS 64
#define PATH_CHARS 32768
#define COMMAND_LINE_BYTES (1u << 20)
#define PROCESS_COMMAND_LINE_INFORMATION 60
typedef LONG (NTAPI *query_process_fn)(HANDLE, ULONG, PVOID, ULONG, PULONG);
typedef struct { USHORT length; USHORT maximum_length; PWSTR buffer; } counted_text;

typedef struct { char *bytes; size_t length, capacity; bool failed; } output;

static void append(output *out, const char *bytes, size_t length) {
    if (out->failed) return;
    if (out->length + length > out->capacity) {
        size_t capacity = out->capacity ? out->capacity : 4096;
        while (capacity < out->length + length) capacity *= 2;
        char *grown = realloc(out->bytes, capacity);
        if (!grown) { out->failed = true; return; }
        out->bytes = grown; out->capacity = capacity;
    }
    memcpy(out->bytes + out->length, bytes, length); out->length += length;
}
static void append_text(output *out, const char *text) { append(out, text, strlen(text)); }

/* JSON string from UTF-16: escape quotes, backslashes and control characters, then UTF-8. */
static void append_wide(output *out, const wchar_t *text, size_t count) {
    append(out, "\"", 1);
    size_t start = 0;
    for (size_t i = 0; i <= count; i++) {
        bool end = i == count;
        wchar_t c = end ? 0 : text[i];
        if (!end && c >= 0x20 && c != L'"' && c != L'\\') continue;
        if (i > start) {
            int bytes = WideCharToMultiByte(CP_UTF8, 0, text + start, (int)(i - start), NULL, 0, NULL, NULL);
            char *utf8 = bytes > 0 ? malloc((size_t)bytes) : NULL;
            if (!utf8 || WideCharToMultiByte(CP_UTF8, 0, text + start, (int)(i - start), utf8, bytes, NULL, NULL) != bytes) { free(utf8); out->failed = true; return; }
            append(out, utf8, (size_t)bytes); free(utf8);
        }
        if (end) break;
        char escaped[8];
        if (c == L'"') append_text(out, "\\\"");
        else if (c == L'\\') append_text(out, "\\\\");
        else { snprintf(escaped, sizeof(escaped), "\\u%04x", (unsigned)c); append_text(out, escaped); }
        start = i + 1;
    }
    append(out, "\"", 1);
}

static bool parse_pid(const char *text, DWORD *pid) {
    size_t length = strlen(text);
    if (length == 0 || length > 10) return false;
    uint64_t value = 0;
    for (size_t i = 0; i < length; i++) {
        if (text[i] < '0' || text[i] > '9') return false;
        value = value * 10 + (uint64_t)(text[i] - '0');
    }
    if (value == 0 || value > 0xFFFFFFFFu) return false;
    *pid = (DWORD)value; return true;
}

/* Get the owner of the accepted socket, even when different programs share
 * the same listening port. Return just the local ports requested by the caller. */
static bool tcp_rows(int family, DWORD first, DWORD second, bool *comma) {
    DWORD size = 0, status;
    void *table = NULL;
    for (;;) {
        status = GetExtendedTcpTable(table, &size, FALSE, family, TCP_TABLE_OWNER_PID_ALL, 0);
        if (status != ERROR_INSUFFICIENT_BUFFER) break;
        free(table);
        if (!size || size > 64u * 1024 * 1024) return false;
        table = malloc(size);
        if (!table) return false;
    }
    if (status != NO_ERROR || !table) { free(table); return false; }
    const MIB_TCPTABLE_OWNER_PID *ipv4 = table;
    const MIB_TCP6TABLE_OWNER_PID *ipv6 = table;
    DWORD count = family == AF_INET ? ipv4->dwNumEntries : ipv6->dwNumEntries;
    for (DWORD i = 0; i < count; i++) {
        DWORD local_port, remote_port, state, pid;
        const void *local_addr, *remote_addr;
        if (family == AF_INET) {
            const MIB_TCPROW_OWNER_PID *row = &ipv4->table[i];
            state = row->dwState; pid = row->dwOwningPid;
            local_port = row->dwLocalPort; remote_port = row->dwRemotePort;
            local_addr = &row->dwLocalAddr; remote_addr = &row->dwRemoteAddr;
        } else {
            const MIB_TCP6ROW_OWNER_PID *row = &ipv6->table[i];
            state = row->dwState; pid = row->dwOwningPid;
            local_port = row->dwLocalPort; remote_port = row->dwRemotePort;
            local_addr = row->ucLocalAddr; remote_addr = row->ucRemoteAddr;
        }
        unsigned port = ntohs((u_short)local_port);
        if ((port != first && port != second) || (state != MIB_TCP_STATE_LISTEN && state != MIB_TCP_STATE_ESTAB)) continue;
        char local[INET6_ADDRSTRLEN], remote[INET6_ADDRSTRLEN] = "";
        if (!InetNtopA(family, local_addr, local, sizeof(local)) ||
            (state == MIB_TCP_STATE_ESTAB && !InetNtopA(family, remote_addr, remote, sizeof(remote)))) {
            free(table); return false;
        }
        printf("%s{\"localAddress\":\"%s\",\"localPort\":%u,\"remoteAddress\":\"%s\",\"remotePort\":%u,\"pid\":%lu}",
               *comma ? "," : "", local, port, remote, state == MIB_TCP_STATE_LISTEN ? 0u : (unsigned)ntohs((u_short)remote_port), (unsigned long)pid);
        *comma = true;
    }
    free(table);
    return true;
}

static void append_error(output *out, DWORD pid, DWORD error) {
    char item[64]; snprintf(item, sizeof(item), "{\"pid\":%lu,\"error\":%lu}", (unsigned long)pid, (unsigned long)error);
    append_text(out, item);
}

static void describe(output *out, DWORD pid, query_process_fn query, wchar_t *path) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) { append_error(out, pid, GetLastError()); return; }
    DWORD length = PATH_CHARS;
    FILETIME created, exited, kernel, user;
    if (!QueryFullProcessImageNameW(process, 0, path, &length) || !GetProcessTimes(process, &created, &exited, &kernel, &user)) {
        append_error(out, pid, GetLastError()); CloseHandle(process); return;
    }
    char head[96];
    uint64_t creation = ((uint64_t)created.dwHighDateTime << 32) | created.dwLowDateTime;
    snprintf(head, sizeof(head), "{\"pid\":%lu,\"path\":", (unsigned long)pid); append_text(out, head);
    append_wide(out, path, length);
    snprintf(head, sizeof(head), ",\"creationTime\":\"%llu\",\"commandLine\":", (unsigned long long)creation); append_text(out, head);
    /* Windows 8.1+ answers this class for query-limited handles; without it the line stays unknown. */
    bool written = false;
    ULONG needed = 0;
    LONG status = query ? query(process, PROCESS_COMMAND_LINE_INFORMATION, NULL, 0, &needed) : -1;
    if (query && needed >= sizeof(counted_text) && needed <= COMMAND_LINE_BYTES) {
        void *buffer = malloc(needed);
        if (buffer) {
            status = query(process, PROCESS_COMMAND_LINE_INFORMATION, buffer, needed, &needed);
            const counted_text *line = buffer;
            if (status >= 0 && line->buffer && line->length % 2 == 0) { append_wide(out, line->buffer, line->length / 2); written = true; }
            free(buffer);
        }
    }
    if (!written) append_text(out, "null");
    /* Windows 8.1+ answers this for query-limited handles too; the console logs it to follow resource growth. */
    DWORD handles = 0;
    if (GetProcessHandleCount(process, &handles)) {
        snprintf(head, sizeof(head), ",\"handleCount\":%lu}", (unsigned long)handles); append_text(out, head);
    } else append_text(out, ",\"handleCount\":null}");
    CloseHandle(process);
}

int main(int argc, char **argv) {
    if (argc >= 2 && strcmp(argv[1], "--tcp") == 0) {
        DWORD first, second = 0;
        if ((argc != 3 && argc != 4) || !parse_pid(argv[2], &first) || first > 65535 ||
            (argc == 4 && (!parse_pid(argv[3], &second) || second > 65535))) return 2;
        bool comma = false;
        putchar('[');
        if (!tcp_rows(AF_INET, first, second, &comma) || !tcp_rows(AF_INET6, first, second, &comma)) {
            fputs("Windows TCP owner table unavailable\n", stderr); return 3;
        }
        puts("]"); return 0;
    }
    if (argc < 2 || argc - 1 > MAX_PIDS) { fputs("usage: tblink-process-identity <pid> [<pid> ...]\n", stderr); return 2; }
    DWORD pids[MAX_PIDS];
    for (int i = 1; i < argc; i++) if (!parse_pid(argv[i], &pids[i - 1])) { fputs("invalid pid\n", stderr); return 2; }
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    query_process_fn query = ntdll ? (query_process_fn)(void *)GetProcAddress(ntdll, "NtQueryInformationProcess") : NULL;
    wchar_t *path = malloc(PATH_CHARS * sizeof(wchar_t));
    if (!path) return 3;
    output out = {0};
    append_text(&out, "[");
    for (int i = 0; i < argc - 1; i++) {
        if (i) append_text(&out, ",");
        describe(&out, pids[i], query, path);
    }
    append_text(&out, "]");
    free(path);
    if (out.failed) return 3;
    HANDLE stdout_handle = GetStdHandle(STD_OUTPUT_HANDLE);
    size_t offset = 0;
    while (offset < out.length) {
        DWORD wrote = 0;
        DWORD chunk = out.length - offset > 0x10000000u ? 0x10000000u : (DWORD)(out.length - offset);
        if (!WriteFile(stdout_handle, out.bytes + offset, chunk, &wrote, NULL) || wrote == 0) return 3;
        offset += wrote;
    }
    free(out.bytes);
    return 0;
}
