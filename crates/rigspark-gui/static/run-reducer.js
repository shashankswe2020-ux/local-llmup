/**
 * Pure client run reducer (task 32.1).
 *
 * A DOM-free state machine for a single chat run so lifecycle transitions can
 * be tested without a browser. It consumes the streamed SSE events the server
 * already emits (`delta`, `tool`, `done`, `error`) plus local UI intents
 * (`submit`, `request-stop`, `cancelled`, `stream-error`) and preserves the
 * prompt and partial reply across failures and cancellations.
 *
 * Attaches to `globalThis.GuiRunReducer` so it loads as a classic browser
 * `<script>` and imports cleanly in the Node test runner.
 */
(function attachRunReducer(scope) {
  "use strict";

  /** UI-facing run phases; a subset of the server run states. */
  const PHASES = Object.freeze({
    idle: "idle",
    sending: "sending",
    running: "running",
    stopping: "stopping",
    completed: "completed",
    cancelled: "cancelled",
    failed: "failed",
  });

  const ACTIVE_PHASES = new Set([PHASES.sending, PHASES.running, PHASES.stopping]);

  function initialRunState() {
    return { phase: PHASES.idle, prompt: "", reply: "", error: null };
  }

  function isActive(state) {
    return ACTIVE_PHASES.has(state.phase);
  }

  function onStreamEvent(state, event) {
    if (event === undefined || event === null || typeof event.type !== "string") {
      return state;
    }
    switch (event.type) {
      case "delta": {
        const reply = state.reply + (typeof event.content === "string" ? event.content : "");
        // A late delta after stop is ignored so a cancelled run stays cancelled.
        if (state.phase === PHASES.stopping || state.phase === PHASES.cancelled) {
          return { ...state, reply };
        }
        return { ...state, phase: PHASES.running, reply };
      }
      case "tool":
        // Tool activity does not change the run phase in this reducer.
        return state;
      case "done":
        if (state.phase === PHASES.cancelled || state.phase === PHASES.failed) {
          return state;
        }
        return { ...state, phase: PHASES.completed };
      case "error":
        return {
          ...state,
          phase: PHASES.failed,
          error: typeof event.message === "string" ? event.message : "unknown error",
        };
      default:
        return state;
    }
  }

  /**
   * Reduce one action into the next run state. Pure: never mutates `state`.
   */
  function reduceRun(state, action) {
    switch (action.type) {
      case "submit":
        return {
          phase: PHASES.sending,
          prompt: typeof action.prompt === "string" ? action.prompt : "",
          reply: "",
          error: null,
        };
      case "stream-event":
        return onStreamEvent(state, action.event);
      case "request-stop":
        return isActive(state) ? { ...state, phase: PHASES.stopping } : state;
      case "cancelled":
        return { ...state, phase: PHASES.cancelled };
      case "stream-error":
        return {
          ...state,
          phase: PHASES.failed,
          error: typeof action.message === "string" ? action.message : "stream error",
        };
      default:
        return state;
    }
  }

  scope.GuiRunReducer = { PHASES, initialRunState, reduceRun, isActive };
})(typeof globalThis !== "undefined" ? globalThis : this);
