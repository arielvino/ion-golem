// Timing constants (milliseconds) for the autonomous/reflex layer.
//
// These are the debounce windows and short delays that keep the bot's reflexes
// from firing on every event tick. They were previously bare numeric literals
// scattered across autonomous.js. One-off action durations that aren't really
// "tunable policy" (e.g. how long to sprint out of fire) are left inline.

module.exports = {
  // How long after interrupt() to wait before prepending a reflex action, so the
  // background task has a chance to observe the abort before we requeue.
  QUEUE_PREPEND_DELAY: 200,

  // Minimum gap between repeated autonomous responses of the same kind.
  DROWNING_DEBOUNCE: 8000,   // re-dispatch swimup at most this often
  ENV_DAMAGE_DEBOUNCE: 3000, // re-react to environmental damage at most this often

  // A dispatched reflex attack takes a moment to reach pvp (prepend delay + equip).
  // Within this window, while its target lives, don't dispatch another one.
  AUTOFIGHT_LAUNCH_GRACE: 2000,

  // Idle item-pickup sweep.
  PICKUP_INTERVAL: 2000,     // how often to scan for nearby dropped items when idle
  PICKUP_NAV_TIMEOUT: 3000,  // give up walking to a dropped item after this long
  PICKUP_SETTLE: 1000,       // after the walk, wait this long for the server to hand the item over
}
