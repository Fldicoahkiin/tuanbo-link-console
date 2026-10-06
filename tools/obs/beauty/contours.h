#pragma once
// Ordered loops from MediaPipe's official face_mesh_connections.py.
static const int lip_ids[40] = {
    61,146,91,181,84,17,314,405,321,375,291,409,270,269,267,0,37,39,40,185,
    78,95,88,178,87,14,317,402,318,324,308,415,310,311,312,13,82,81,80,191
};
static const int eye_brow_ids[4][20] = {
    {33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246},
    {263,249,390,373,374,380,381,382,362,398,384,385,386,387,388,466},
    {46,53,52,65,55,107,66,105,63,70},
    {276,283,282,295,285,336,296,334,293,300}
};
static void makeup_geometry(const struct face_state *state, float points[FACE_LIMIT][160],
                            float bounds[FACE_LIMIT][16], float cheeks[FACE_LIMIT][4])
{
    for (int face = 0; face < state->count; ++face) {
        for (int part = 0; part < 4; ++part) {
            float *box = bounds[face] + part * 4;
            box[0] = box[1] = 1;
            for (int i = 0; i < (part < 2 ? 16 : 10); ++i) {
                const float *xy = state->landmarks[face] + eye_brow_ids[part][i] * 2;
                memcpy(points[face] + part * 40 + i * 2, xy, sizeof(float) * 2);
                box[0] = fminf(box[0], xy[0]); box[1] = fminf(box[1], xy[1]);
                box[2] = fmaxf(box[2], xy[0]); box[3] = fmaxf(box[3], xy[1]);
            }
        }
        const int centers[2][3] = {{234, 1, 61}, {454, 1, 291}};
        for (int side = 0; side < 2; ++side)
            for (int axis = 0; axis < 2; ++axis)
                for (int vertex = 0; vertex < 3; ++vertex)
                    cheeks[face][side * 2 + axis] += state->landmarks[face][centers[side][vertex] * 2 + axis] / 3;
    }
}
static void lip_geometry(const struct face_state *state, float points[FACE_LIMIT][80], float bounds[FACE_LIMIT][4])
{
    for (int face = 0; face < state->count; ++face) {
        bounds[face][0] = bounds[face][1] = 1;
        for (int point = 0; point < 40; ++point) {
            const float *xy = state->landmarks[face] + lip_ids[point] * 2;
            memcpy(points[face] + point * 2, xy, sizeof(float) * 2);
            if (point < 20) {
                bounds[face][0] = fminf(bounds[face][0], xy[0]);
                bounds[face][1] = fminf(bounds[face][1], xy[1]);
                bounds[face][2] = fmaxf(bounds[face][2], xy[0]);
                bounds[face][3] = fmaxf(bounds[face][3], xy[1]);
            }
        }
    }
}
