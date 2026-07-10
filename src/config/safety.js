// Safety thresholds — health and oxygen levels that trigger autonomous responses.
// Health, food and oxygen are on a 0–20 scale (each on-screen icon = 2 points).
//
// The health 8-vs-6 split is INTENTIONAL, not a bug: 8 is a "top up before it's
// dangerous" trigger that prepends an eat to the queue without interrupting; 6 is
// the "stop everything" emergency that aborts the current atomic step. Keeping them
// named makes the two-stage response explicit so they don't get accidentally merged.

module.exports = {
  // --- Health (0–20) ---
  HEALTH_AUTOEAT: 8,    // autonomous: prepend an eat to recover before it gets risky
  HEALTH_CRITICAL: 6,   // guard/nav/engine: emergency interrupt of the current step

  // --- Oxygen / breath (0–20) ---
  OXYGEN_DROWNING: 4,   // autonomous: dispatch swimup (only if head is verified in water)
  OXYGEN_LOW: 6,        // guard/nav/engine: drowning interrupt
  OXYGEN_FALL_SAFE: 10, // above this we weren't underwater → treat damage as a fall
  OXYGEN_SURFACED: 18,  // swimup target: stop once breath is essentially restored

  // --- Food (0–20) ---
  FOOD_STARVING: 0,     // food at 0 means health starts ticking down → wake to eat
  FOOD_FULL: 20,        // food bar full → skip eating
}
