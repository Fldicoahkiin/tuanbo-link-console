#include <windows.h>
#include <stdint.h>
#include <stddef.h>
#include <math.h>
#include <string.h>
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <assert.h>
#include "face.h"
#include "live.h"

static void response(struct live_transport *t, uint64_t now)
{
    uint8_t pixels[16] = {0};
    live_publish(t, pixels, 8, 2, 2, now - 20, 1);
    struct live_memory *m = t->memory;
    m->result_epoch = t->epoch; m->result_sequence = t->sequence;
    m->result_ms = now - 20; m->result_count = 1; m->result_error = 0;
    m->semantic_present = 0; m->profile_count = 0;
    for (int i = 0; i < REGION_VALUES; i++) m->regions[0][i] = 0.25f;
}

int main(void)
{
    struct live_transport t = {0};
    struct face_state state = {0};
    uint64_t stamp = 0, now = GetTickCount64();
    assert(live_open(&t));
    assert(t.memory->version == 7);
    response(&t, now);
    assert(live_receive(&t, &state, now, &stamp) && state.valid && state.count == 1);
    assert(state.landmarks[0][0] == .25f && state.landmarks[0][LANDMARK_VALUES - 1] == .25f);
    assert(!live_receive(&t, &state, now, &stamp) && state.valid); // duplicate ignored
    response(&t, now); t.memory->semantic_present = 1; t.memory->semantic_mask[42] = 211;
    assert(live_receive(&t, &state, now, &stamp) && state.semantic_present && state.semantic_mask[42] == 211);
    assert(!live_receive(&t, &state, now + LIVE_MAX_AGE + 1, &stamp) && !state.semantic_present && state.semantic_mask[42] == 0);
    response(&t, now); t.memory->semantic_present = 2;
    assert(!live_receive(&t, &state, now, &stamp) && !state.valid);
    response(&t, now); t.memory->result_epoch++;
    assert(!live_receive(&t, &state, now, &stamp) && !state.valid);
    response(&t, now); t.memory->regions[0][12] = NAN;
    assert(!live_receive(&t, &state, now, &stamp) && !state.valid);
    response(&t, now); t.memory->regions[0][REGION_VALUES - 1] = 1.1f;
    assert(!live_receive(&t, &state, now, &stamp) && !state.valid);
    response(&t, now); t.memory->result_ms--;
    assert(!live_receive(&t, &state, now, &stamp) && !state.valid); // forged time
    response(&t, now); t.memory->result_sequence++;
    assert(!live_receive(&t, &state, now, &stamp) && !state.valid); // future frame
    response(&t, now); t.memory->regions[0][0] = NAN;
    assert(!live_receive(&t, &state, now, &stamp) && !state.valid);
    response(&t, now); t.memory->result_count = 7;
    assert(!live_receive(&t, &state, now, &stamp) && !state.valid);
    response(&t, now); t.memory->result_error = 1;
    assert(!live_receive(&t, &state, now, &stamp) && !state.valid);
    response(&t, now); t.memory->result_count = 0;
    assert(live_receive(&t, &state, now, &stamp) && !state.valid); // no faces clears
    response(&t, now);
    assert(live_receive(&t, &state, now, &stamp) && state.valid);
    assert(!live_receive(&t, &state, now + LIVE_MAX_AGE + 1, &stamp) && !state.valid);
    response(&t, now); t.memory->result_count = 0;
    t.memory->semantic_present = 1; t.memory->profile_count = 1; t.memory->profile_guard[123] = 211;
    assert(live_receive(&t, &state, now, &stamp) && state.valid && state.count == 0 && state.profile_count == 1);
    assert(state.profile_guard[123] == 211);
    assert(!live_receive(&t, &state, now + LIVE_MAX_AGE + 1, &stamp) && !state.valid && !state.profile_count && !state.profile_guard[123]);
    response(&t, now); t.memory->profile_count = 1;
    assert(!live_receive(&t, &state, now, &stamp)); // profile requires semantic protection
    response(&t, now); t.memory->semantic_present = 1; t.memory->profile_count = 6;
    assert(!live_receive(&t, &state, now, &stamp)); // total people exceeds six
    struct body_state body = {0};
    uint64_t body_stamp = 0;
    response(&t, now);
    t.memory->body_epoch = t.epoch; t.memory->body_sequence = t.sequence;
    t.memory->body_ms = now - 20; t.memory->body_count = 1;
    for (int i = 0; i < BODY_JOINT_VALUES; ++i) t.memory->body_joints[0][i] = .8f;
    t.memory->body_masks[0][1234] = 197;
    assert(live_receive_body(&t, &body, now, &body_stamp) && body.count == 1);
    assert(body.masks[0][1234] == 197 && body.joints[0][98] == .8f);
    assert(!live_receive_body(&t, &body, now, &body_stamp) && body.count == 1);
    assert(!live_receive_body(&t, &body, now + LIVE_MAX_AGE + 1, &body_stamp) && body.count == 0);
    response(&t, now); t.memory->body_sequence = t.sequence; t.memory->body_joints[0][0] = NAN;
    assert(!live_receive_body(&t, &body, now, &body_stamp) && body.count == 0);
    t.memory->body_joints[0][0] = .8f; t.memory->body_joints[0][35] = .2f;
    assert(!live_receive_body(&t, &body, now, &body_stamp) && body.count == 0);
    t.memory->body_joints[0][35] = .8f; t.memory->body_epoch++;
    assert(!live_receive_body(&t, &body, now, &body_stamp) && body.count == 0);
    t.memory->body_epoch = t.epoch; t.memory->body_ms--;
    assert(!live_receive_body(&t, &body, now, &body_stamp) && body.count == 0);
    t.memory->body_ms = now - 20; t.memory->body_count = 7;
    assert(!live_receive_body(&t, &body, now, &body_stamp) && body.count == 0);
    t.memory->body_count = 0;
    assert(live_receive_body(&t, &body, now, &body_stamp) && body.count == 0);
    response(&t, now); t.memory->body_sequence = t.sequence; t.memory->body_count = 1;
    t.memory->body_error = 1;
    assert(!live_receive_body(&t, &body, now, &body_stamp) && body.count == 0);
    t.memory->body_error = 0; t.memory->body_joints[0][98] = 1.1f;
    assert(!live_receive_body(&t, &body, now, &body_stamp) && body.count == 0);
    t.memory->body_joints[0][98] = .8f;
    assert(live_receive_body(&t, &body, now, &body_stamp) && body.count == 1);
    live_close(&t);
    puts("PASS: face/body validation, duplicate, epoch, timestamp, sequence, NaN, range, count, confidence, error, empty and expiry");
    return 0;
}
