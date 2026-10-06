#pragma once
#include <stdbool.h>
#include <stdint.h>
#define FACE_MASK_EDGE 160
#define FACE_MASK_BYTES (FACE_MASK_EDGE * FACE_MASK_EDGE)
#define FACE_LIMIT 6
#define LANDMARK_VALUES 956
#define REGION_VALUES (12 + LANDMARK_VALUES)
struct face_state {
    float face[FACE_LIMIT][4];
    float eyes[FACE_LIMIT][4];
    float controls[FACE_LIMIT][4];
    float landmarks[FACE_LIMIT][LANDMARK_VALUES];
    int count;
    bool valid;
    bool semantic_present;
    uint8_t semantic_mask[FACE_MASK_BYTES];
    uint32_t profile_count;
    uint8_t profile_guard[FACE_MASK_BYTES];
};
