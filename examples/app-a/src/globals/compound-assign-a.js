// Compound assignment collision fixture.
//
// Uses compound assignment operators (|=, <<=) which the engine
// should correctly classify as write operations, emitting a
// shared-globals finding when paired with app-b.

window.COLLIDING_COMPOUND_GLOBAL ||= new Set();

export function updateFlags() {
  globalThis.FEATURE_FLAGS_BITMASK <<= 1;
}
