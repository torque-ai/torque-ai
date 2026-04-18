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

    // Model discovery events
    onModelDiscovered: (fn) => emitter.on('model-discovered', fn),
    emitModelDiscovered: (data) => emitter.emit('model-discovered', data),

    // Model removal events
    onModelRemoved: (fn) => emitter.on('model-removed', fn),
    emitModelRemoved: (data) => emitter.emit('model-removed', data),

    // Low-level access for listener management (e.g. removeStaleListeners patterns)
    listeners: (event) => emitter.listeners(event),
    removeListener: (event, fn) => emitter.removeListener(event, fn),

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
