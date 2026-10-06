// Local, owner-restricted, bounded transport. No cameras, network or worker thread.
#include <sddl.h>
#include <stdio.h>
#define LIVE_EDGE 640
#define LIVE_BYTES (LIVE_EDGE * LIVE_EDGE * 4)
#define LIVE_MAGIC 0x31464254u
#define LIVE_MAX_AGE 250
#define BODY_LIMIT 6
#define BODY_JOINT_VALUES 99
#define BODY_MASK_EDGE 160
#define BODY_MASK_BYTES (BODY_MASK_EDGE * BODY_MASK_EDGE)
struct body_state {
    uint32_t count;
    float joints[BODY_LIMIT][BODY_JOINT_VALUES];
    uint8_t masks[BODY_LIMIT][BODY_MASK_BYTES];
};
struct live_memory {
    uint32_t magic, version;
    volatile LONG alive;
    uint32_t epoch, width, height, stride, sequence;
    uint64_t captured_ms;
    uint32_t accepted_sequence, status;
    uint32_t result_epoch, result_sequence, result_count, result_error;
    uint64_t result_ms;
    float regions[FACE_LIMIT][REGION_VALUES];
    uint32_t body_accepted_sequence, body_status;
    uint32_t body_epoch, body_sequence, body_count, body_error;
    uint64_t body_ms;
    float body_joints[BODY_LIMIT][BODY_JOINT_VALUES];
    uint8_t body_masks[BODY_LIMIT][BODY_MASK_BYTES];
    uint8_t rgba[LIVE_BYTES];
    uint32_t semantic_present;
    uint8_t semantic_mask[FACE_MASK_BYTES];
    uint32_t profile_count;
    uint8_t profile_guard[FACE_MASK_BYTES];
    uint64_t analysis_flags;
};
_Static_assert(offsetof(struct live_memory, body_accepted_sequence) == 23304, "Body status ABI");
_Static_assert(offsetof(struct live_memory, body_epoch) == 23312, "Body result ABI");
_Static_assert(offsetof(struct live_memory, rgba) == 179312, "Transport ABI");
_Static_assert(offsetof(struct live_memory, semantic_present) == 1817712, "Semantic transport ABI");
_Static_assert(offsetof(struct live_memory, profile_count) == 1843316, "Profile transport ABI");
_Static_assert(offsetof(struct live_memory, analysis_flags) == 1868920, "Analysis demand ABI");
_Static_assert(sizeof(struct live_memory) == 1868928, "Transport capacity ABI");
struct live_transport {
    HANDLE mapping, mutex;
    struct live_memory *memory;
    char name[128];
    uint32_t sequence, epoch, accepted, body_accepted;
    uint64_t timestamps[32];
};
static volatile LONG live_instance;

static bool live_open(struct live_transport *live)
{
    snprintf(live->name, sizeof(live->name), "Local\\tblink-beauty-%lu-%ld", GetCurrentProcessId(), InterlockedIncrement(&live_instance));
    char mutex_name[160];
    snprintf(mutex_name, sizeof(mutex_name), "%s-lock", live->name);
    PSECURITY_DESCRIPTOR descriptor = NULL;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorA("D:P(A;;GA;;;OW)(A;;GA;;;SY)", SDDL_REVISION_1, &descriptor, NULL)) return false;
    SECURITY_ATTRIBUTES security = {sizeof(security), descriptor, FALSE};
    live->mapping = CreateFileMappingA(INVALID_HANDLE_VALUE, &security, PAGE_READWRITE, 0, sizeof(struct live_memory), live->name);
    if (live->mapping && GetLastError() == ERROR_ALREADY_EXISTS) {
        CloseHandle(live->mapping); live->mapping = NULL;
        LocalFree(descriptor); return false;
    }
    live->mutex = CreateMutexA(&security, FALSE, mutex_name);
    LocalFree(descriptor);
    if (!live->mapping || !live->mutex) return false;
    live->memory = MapViewOfFile(live->mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(struct live_memory));
    if (!live->memory) return false;
    memset(live->memory, 0, sizeof(*live->memory));
    live->memory->magic = LIVE_MAGIC;
    live->memory->version = 7;
    live->memory->alive = 1;
    live->epoch = 1;
    return true;
}

static void live_close(struct live_transport *live)
{
    if (live->memory) {
        InterlockedExchange(&live->memory->alive, 0);
        UnmapViewOfFile(live->memory);
    }
    if (live->mapping) CloseHandle(live->mapping);
    if (live->mutex) CloseHandle(live->mutex);
    memset(live, 0, sizeof(*live));
}

static bool live_lock(struct live_transport *live)
{
    if (!live->memory) return false;
    DWORD result = WaitForSingleObject(live->mutex, 0);
    if (result == WAIT_ABANDONED) {
        live->memory->result_sequence = 0;
        live->memory->body_sequence = 0;
        live->memory->body_status = 4;
        live->memory->status = 4;
        ReleaseMutex(live->mutex);
        return false;
    }
    return result == WAIT_OBJECT_0;
}

static void live_publish(struct live_transport *live, uint8_t *data, uint32_t stride,
                         uint32_t width, uint32_t height, uint64_t captured, uint64_t analysis_flags)
{
    if (!live_lock(live)) return;
    struct live_memory *m = live->memory;
    m->epoch = live->epoch;
    m->width = width; m->height = height; m->stride = width * 4;
    m->sequence = ++live->sequence; m->captured_ms = captured;
    m->analysis_flags = analysis_flags;
    live->timestamps[live->sequence % 32] = captured;
    for (uint32_t y = 0; y < height; ++y) memcpy(m->rgba + y * width * 4, data + y * stride, width * 4);
    ReleaseMutex(live->mutex);
}

static bool live_receive(struct live_transport *live, struct face_state *out, uint64_t now, uint64_t *accepted_time)
{
    if (!live_lock(live)) return false;
    struct live_memory *m = live->memory;
    bool fresh = m->result_sequence > live->accepted && m->result_sequence <= live->sequence;
    bool valid = fresh && m->result_epoch == live->epoch && live->sequence - m->result_sequence < 32 &&
        m->result_ms == live->timestamps[m->result_sequence % 32] && m->result_ms <= now &&
        now - m->result_ms <= LIVE_MAX_AGE && m->result_count <= FACE_LIMIT && m->result_error == 0 && m->semantic_present <= 1 &&
        m->profile_count <= FACE_LIMIT - m->result_count && (!m->profile_count || m->semantic_present == 1);
    struct face_state next = {0};
    for (uint32_t i = 0; valid && i < m->result_count; ++i) {
        const float *r = m->regions[i];
        for (int j = 0; j < REGION_VALUES; ++j) if (!isfinite(r[j]) || r[j] < 0 || r[j] > 1) valid = false;
        if (r[2] < 0.005f || r[3] < 0.005f || r[2] > 0.5f || r[3] > 0.5f) valid = false;
        memcpy(next.face[i], r, sizeof(float) * 4);
        memcpy(next.eyes[i], r + 4, sizeof(float) * 4);
        memcpy(next.controls[i], r + 8, sizeof(float) * 4);
        memcpy(next.landmarks[i], r + 12, sizeof(float) * LANDMARK_VALUES);
    }
    if (valid) {
        next.count = (int)m->result_count; next.profile_count = m->profile_count; next.valid = next.count > 0 || next.profile_count > 0;
        if (next.profile_count) memcpy(next.profile_guard, m->profile_guard, FACE_MASK_BYTES);
        next.semantic_present = m->semantic_present == 1;
        if (next.semantic_present) memcpy(next.semantic_mask, m->semantic_mask, FACE_MASK_BYTES);
        *out = next; *accepted_time = m->result_ms;
        live->accepted = m->result_sequence;
        m->accepted_sequence = live->accepted;
        m->status = next.valid ? 1 : 2;
    } else if (fresh || m->result_error) {
        memset(out, 0, sizeof(*out)); *accepted_time = 0;
        m->status = 4;
    } else if (!*accepted_time || now - *accepted_time > LIVE_MAX_AGE) {
        memset(out, 0, sizeof(*out));
        m->status = 3;
    }
    ReleaseMutex(live->mutex);
    return valid;
}

static bool live_receive_body(struct live_transport *live, struct body_state *out, uint64_t now, uint64_t *accepted_time)
{
    if (!live_lock(live)) return false;
    struct live_memory *m = live->memory;
    bool fresh = m->body_sequence > live->body_accepted && m->body_sequence <= live->sequence;
    bool valid = fresh && m->body_epoch == live->epoch && live->sequence - m->body_sequence < 32 &&
        m->body_ms == live->timestamps[m->body_sequence % 32] && m->body_ms <= now &&
        now - m->body_ms <= LIVE_MAX_AGE && m->body_count <= BODY_LIMIT && m->body_error == 0;
    for (uint32_t i = 0; valid && i < m->body_count; ++i) {
        for (int j = 0; j < BODY_JOINT_VALUES; ++j) {
            float value = m->body_joints[i][j];
            if (!isfinite(value) || value < 0 || value > 1) valid = false;
        }
        const int torso[4] = {11,12,23,24};
        for (int j = 0; j < 4; ++j) if (m->body_joints[i][torso[j] * 3 + 2] < 0.6f) valid = false;
    }
    if (valid) {
        out->count = m->body_count;
        memcpy(out->joints, m->body_joints, sizeof(out->joints));
        memcpy(out->masks, m->body_masks, sizeof(out->masks));
        *accepted_time = m->body_ms;
        live->body_accepted = m->body_sequence;
        m->body_accepted_sequence = live->body_accepted;
        m->body_status = out->count ? 1 : 2;
    } else if (fresh || m->body_error) {
        out->count = 0; *accepted_time = 0; m->body_status = 4;
    } else if (!*accepted_time || now - *accepted_time > LIVE_MAX_AGE) {
        out->count = 0; m->body_status = 3;
    }
    ReleaseMutex(live->mutex);
    return valid;
}
