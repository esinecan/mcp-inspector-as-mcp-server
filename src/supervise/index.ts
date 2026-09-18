/**
 * The supervision module's public surface. A command imports from here and
 * from nowhere deeper: the executor, the operations it takes, the report it
 * throws, and the lanes a `context()` wires behind it.
 */

export { McpExecutor, type ExecuteOptions, type Executed, type CircuitRow } from "./executor.js";
export { type Operation, type OperationKind, targetOf } from "./operation.js";
export {
  SupervisedError,
  plainEnvelope,
  EXIT_REFUSED,
  type FailureReport,
  type CircuitSummary,
} from "./errors.js";
export {
  ClassifiedError,
  classifyResult,
  classifyThrown,
  type Classified,
  type FailureClass,
  type RefusalReason,
} from "./classify.js";
export { type Lane, DaemonUnavailable } from "./lane.js";
export { EphemeralLane } from "./ephemeral-lane.js";
export { DaemonLane } from "./daemon-lane.js";
export { ScriptedLane, type Step } from "./scripted-lane.js";
export { fileStateStore, memoryStateStore, type StateStore } from "./store.js";
export {
  fileSink,
  memorySink,
  NO_EVENTS,
  newTrace,
  type EventSink,
  type SupervisorEvent,
} from "./events.js";
export { Gate, Gates, QueueFull, QueueTimeout } from "./queue.js";
export { redact, digestOf } from "./redact.js";
