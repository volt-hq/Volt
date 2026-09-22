export const MAX_AHEAD_CYCLES = 12;
export const MAX_AHEAD_EVALUATIONS = MAX_AHEAD_CYCLES * 5;
export const MAX_AHEAD_EXCERPT_BYTES = 3000;
export const MAX_AHEAD_PACKET_BYTES = 8000;
// Leave 16 of the default host's 64 operations for source validation at later boundaries.
export const MAX_AHEAD_NATIVE_OPERATIONS = 48;
