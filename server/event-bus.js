'use strict';
const { EventEmitter } = require('events');

/**
 * Create a new event bus instance.
 * @returns {object} Event bus with typed on/emit methods
 */
function createEventBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  return {
    // Queue events
    onQueueChanged: (fn) => emitter.on('queue-changed', fn),
    emitQueueChanged: () => {
      emitter.emit('queue-changed');
      process.emit('torque:queue-changed');
    },

    // Shutdown events
    onShutdown: (fn) => emitter.on('shutdown', fn),
    emitShutdown: (reason) => emitter.emit('shutdown', reason),

    // Task update events
    onTaskUpdated: (fn) => emitter.on('task-updated', fn),
    emitTaskUpdated: (data) => emitter.emit('task-updated', data),

    // Task lifecycle events (e.g. cancellation notices)
    onTaskEvent: (fn) => emitter.on('task-event', fn),
    emitTaskEvent: (data) => emitter.emit('task-event', data),

    // Factory loop state-change events (wakes awaitFactoryLoop instantly)
    onFactoryLoopChanged: (fn) => emitter.on('factory-loop-changed', fn),
    emitFactoryLoopChanged: (data) => emitter.emit('factory-loop-changed', data),
    removeFactoryLoopListener: (fn) => emitter.removeListener('factory-loop-changed', fn),

    // Factory stalled-loop events
    onFactoryLoopStalled: (fn) => emitter.on('factory:loop_stalled', fn),
    emitFactoryLoopStalled: (data) => emitter.emit('factory:loop_stalled', data),

    // Factory VERIFY auto-recovery events
    onFactoryVerifyAutoRetry: (fn) => emitter.on('factory:verify_auto_retry', fn),
    emitFactoryVerifyAutoRetry: (data) => emitter.emit('factory:verify_auto_retry', data),
    onFactoryVerifyUnrecoverable: (fn) => emitter.on('factory:verify_unrecoverable', fn),
    emitFactoryVerifyUnrecoverable: (data) => emitter.emit('factory:verify_unrecoverable', data),

    // Factory plan-quality-gate events
    emitFactoryPlanRejectedQuality: (data) => emitter.emit('factory:plan_rejected_quality', data),
    onFactoryPlanRejectedQuality: (fn) => emitter.on('factory:plan_rejected_quality', fn),
    emitFactoryPlanRejectedFinal: (data) => emitter.emit('factory:plan_rejected_final', data),
    onFactoryPlanRejectedFinal: (fn) => emitter.on('factory:plan_rejected_final', fn),
    emitFactoryReplanRecoveryAttempted: (data) => emitter.emit('factory:replan_recovery_attempted', data),
    onFactoryReplanRecoveryAttempted: (fn) => emitter.on('factory:replan_recovery_attempted', fn),
    emitFactoryReplanRecoveryExhausted: (data) => emitter.emit('factory:replan_recovery_exhausted', data),
    onFactoryReplanRecoveryExhausted: (fn) => emitter.on('factory:replan_recovery_exhausted', fn),
    emitFactoryPlanGateSkipped: (data) => emitter.emit('factory:plan_gate_skipped', data),
    onFactoryPlanGateSkipped: (fn) => emitter.on('factory:plan_gate_skipped', fn),
    emitFactoryProjectBaselineBroken: (data) => emitter.emit('factory:project_baseline_broken', data),
    onFactoryProjectBaselineBroken: (fn) => emitter.on('factory:project_baseline_broken', fn),
    emitFactoryProjectBaselineCleared: (data) => emitter.emit('factory:project_baseline_cleared', data),
    onFactoryProjectBaselineCleared: (fn) => emitter.on('factory:project_baseline_cleared', fn),
    emitFactoryProjectEnvironmentFailure: (data) => emitter.emit('factory:project_environment_failure', data),
    onFactoryProjectEnvironmentFailure: (fn) => emitter.on('factory:project_environment_failure', fn),

    // Model discovery events
    onModelDiscovered: (fn) => emitter.on('model-discovered', fn),
    emitModelDiscovered: (data) => emitter.emit('model-discovered', data),

    // Model removal events
    onModelRemoved: (fn) => emitter.on('model-removed', fn),
    emitModelRemoved: (data) => emitter.emit('model-removed', data),

    // Low-level access for listener management (e.g. removeStaleListeners patterns)
    listeners: (event) => emitter.listeners(event),
    removeListener: (event, fn) => emitter.removeListener(event, fn),

    // Generic pass-through for code that needs raw event subscriptions on
    // event names not exposed as typed methods (e.g. circuit-breaker emits
    // 'circuit:tripped' / 'circuit:recovered'; budget-watcher subscribes
    // generically). Without these, factories registered against ['eventBus']
    // that call eventBus.on(...) on construction crash container.boot()
    // with 'eventBus.on is not a function', taking out every DI service
    // including providerScoring, autoRecoveryEngine, and starvationRecovery.
    on: (event, fn) => emitter.on(event, fn),
    emit: (event, payload) => emitter.emit(event, payload),
    off: (event, fn) => emitter.off(event, fn),

    // Cleanup
    removeAllListeners: () => emitter.removeAllListeners(),
  };
}

// Default singleton — existing require('./event-bus') callers get this
const defaultBus = createEventBus();

module.exports = {
  ...defaultBus,
  createEventBus,
};
