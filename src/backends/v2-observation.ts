import type { OpenCode, SessionLogOutput, SessionMessageAssistant } from "@opencode/client";
import type { JobSnapshot, JobStatus } from "../jobs.js";
import { createRequestContext, withAbort, type RequestOptions } from "../async.js";
import { formatMessageResponse } from "../helpers.js";
import { normalizeMessage, normalizeSession } from "./normalization.js";

export type V2Api = ReturnType<typeof OpenCode.make>;
/** Persisted evidence, not reconstructed parentage based on message timestamps. */
export interface V2ObservationState {
  version: 1;
  cursor: number;
  messageId: string;
  admitted?: boolean;
  delivered?: boolean;
  userProjectionValidated?: boolean;
  queued?: boolean;
  latestDeliveredId?: string;
  executionStart?: number;
  targetExecution?: number;
  ownsExecution?: boolean;
  ownershipLost?: boolean;
  assistantIds: string[];
  completedAssistantIds: string[];
  interruption?: "user" | "shutdown" | "superseded" | "inactivity";
  outcome?: "completed" | "failed" | "cancelled";
  error?: unknown;
  synced?: boolean;
  pendingKinds?: Record<string, string>;
  pendingDeliveries?: Record<string, string>;
  finalAssistantId?: string;
}

export const initialV2Observation = (messageId: string): V2ObservationState => ({
  version: 1, cursor: 0, messageId, assistantIds: [], completedAssistantIds: [],
});

function observeEvent(state: V2ObservationState, event: Exclude<SessionLogOutput, { type: "log.synced" }>): void {
  const data = event.data as Record<string, any>;
  // An established terminal receipt remains valid when later work is submitted.
  if (state.outcome) return;
  switch (event.type) {
    case "session.inbox.enqueued":
      (state.pendingKinds ??= {})[data.inboxID] = data.item?.type;
      (state.pendingDeliveries ??= {})[data.inboxID] = data.item?.delivery;
      if (data.inboxID === state.messageId) { state.admitted = true; state.queued = true; }
      break;
    case "session.inbox.cancelled":
      if (data.inboxID === state.messageId) { state.queued = false; state.outcome = "cancelled"; }
      break;
    case "session.execution.started": {
      state.executionStart = event.durable.seq;
      const resume = state.delivered && state.latestDeliveredId === state.messageId && !state.ownershipLost &&
        ["shutdown", "inactivity"].includes(state.interruption ?? "");
      state.ownsExecution = !!resume;
      if (resume) { state.targetExecution = event.durable.seq; delete state.interruption; }
      break;
    }
    case "session.inbox.delivery.changed":
      (state.pendingDeliveries ??= {})[data.inboxID] = data.delivery;
      break;
    case "session.inbox.delivered": {
      const delivery = state.pendingDeliveries?.[data.inboxID];
      if (state.pendingDeliveries) delete state.pendingDeliveries[data.inboxID];
      // Explicit compaction is queued control work, not a competing user turn.
      if (state.pendingKinds?.[data.inboxID] === "compaction") { delete state.pendingKinds[data.inboxID]; break; }
      if (state.pendingKinds) delete state.pendingKinds[data.inboxID];
      state.latestDeliveredId = data.inboxID;
      if (data.inboxID === state.messageId) {
        state.admitted = true; state.queued = false; state.delivered = true;
        state.targetExecution = state.executionStart;
        state.ownsExecution = state.executionStart !== undefined;
        state.ownershipLost = false;
      } else if (state.delivered) {
        if (state.ownsExecution && state.finalAssistantId && delivery === "queue") {
          state.outcome = "completed"; state.ownsExecution = false; break;
        }
        // A terminal event has only sessionID. It cannot safely attribute a
        // shared execution to this job after another input has been delivered.
        state.ownsExecution = false; state.ownershipLost = true;
      }
      break;
    }
    case "session.step.started":
      if (state.ownsExecution && !state.ownershipLost && typeof data.assistantMessageID === "string") {
        delete state.finalAssistantId;
        if (!state.assistantIds.includes(data.assistantMessageID)) state.assistantIds.push(data.assistantMessageID);
      }
      break;
    case "session.step.ended":
      if (state.ownsExecution && !state.ownershipLost && state.assistantIds.includes(data.assistantMessageID)) {
        if (!state.completedAssistantIds.includes(data.assistantMessageID)) state.completedAssistantIds.push(data.assistantMessageID);
        if (["stop", "length", "content-filter"].includes(data.finish)) state.finalAssistantId = data.assistantMessageID;
      }
      break;
    case "session.execution.succeeded":
      if (state.ownsExecution && !state.ownershipLost && state.targetExecution === state.executionStart) {
        state.outcome = "completed"; state.ownsExecution = false;
      }
      break;
    case "session.execution.failed":
      if (state.ownsExecution && !state.ownershipLost && state.targetExecution === state.executionStart) {
        state.outcome = "failed"; state.error = data.error; state.ownsExecution = false;
      }
      break;
    case "session.execution.interrupted":
      if (state.ownsExecution && !state.ownershipLost && state.targetExecution === state.executionStart) {
        state.interruption = data.reason; state.ownsExecution = false;
        if (data.reason === "user") state.outcome = "cancelled";
        if (data.reason === "superseded") state.ownershipLost = true;
      }
      break;
  }
}

/** Replay the finite durable session log. Global volatile events/idle are not completion evidence. */
export async function observeV2Session(
  api: V2Api, sessionId: string, messageId: string, options: RequestOptions = {}, persistedState?: V2ObservationState,
): Promise<{ snapshot: JobSnapshot; state: V2ObservationState }> {
  if (!sessionId || !messageId) throw new Error("V2 observation requires sessionId and messageId");
  if (persistedState && (persistedState.version !== 1 || persistedState.messageId !== messageId ||
    !Number.isSafeInteger(persistedState.cursor) || persistedState.cursor < 0)) throw new Error("Invalid V2 observation state");
  const state = structuredClone(persistedState ?? initialV2Observation(messageId));
  const snapshot: JobSnapshot = { backend: "v2", sessionId, messageId, status: "unknown", inputs: [] };
  const context = createRequestContext(options);
  const request = { signal: context.signal };
  const read = <T>(operation: Promise<T>) => withAbort(operation, context.signal);
  try {
    state.synced = false;
    let count = 0;
    const iterator = api.session.log({ sessionID: sessionId, after: state.cursor, follow: false }, request)[Symbol.asyncIterator]();
    try {
      while (count++ < 10_000) {
        const next = await withAbort(iterator.next(), context.signal);
        if (next.done) break;
        const event = next.value;
        if (event.type === "log.synced") {
          if (event.aggregateID !== sessionId) throw new Error("V2 log sync belongs to a different session");
          if (event.seq !== undefined && (!Number.isSafeInteger(event.seq) || event.seq < state.cursor)) throw new Error("V2 log returned an invalid sync cursor");
          // The native log filters obsolete event types; its sync cursor may advance past emitted rows.
          if (event.seq !== undefined) state.cursor = event.seq;
          state.synced = true; break;
        }
        if (event.durable.aggregateID !== sessionId || (event.data as { sessionID?: string }).sessionID !== sessionId) {
          throw new Error("V2 log returned an event from another session");
        }
        if (!Number.isSafeInteger(event.durable.seq) || event.durable.seq < 0) throw new Error("V2 log returned an invalid cursor");
        if (event.durable.seq <= state.cursor) continue;
        observeEvent(state, event);
        state.cursor = event.durable.seq;
      }
    } finally {
      // The SDK stream uses the request abort signal; cancelling this iterator
      // only closes observation, never interrupts backend execution.
      if (iterator.return) await withAbort(iterator.return(), context.signal).catch(() => {});
    }
    if (!state.synced) {
      snapshot.error = { name: "IncompleteSessionLog", message: "Session replay is incomplete; observe again without resubmitting." };
      return { snapshot, state };
    }
    const session = await read(api.session.get({ sessionID: sessionId }, request));
    snapshot.session = normalizeSession(session); snapshot.directory = session.location.directory;
    const inbox = await read(api.session.inbox.list({ sessionID: sessionId }, request));
    const queued = inbox.find(item => item.id === messageId);
    if (queued) { state.admitted = true; state.queued = true; }
    else if (state.delivered || state.outcome) state.queued = false;

    // Admission and delivery are separate from history projection. Validate
    // their shared public identity before exposing output or input controls.
    // A delayed 404 remains recoverable and never causes prompt resubmission.
    if (state.delivered && !state.userProjectionValidated) {
      const user = await read(api.session.message.get({ sessionID: sessionId, messageID: messageId }, request));
      if (user.id !== messageId || user.type !== "user") throw new Error("V2 returned a mismatched user message projection");
      state.userProjectionValidated = true;
    }

    let assistant: SessionMessageAssistant | undefined;
    const lastAssistant = (state.outcome === "completed" ? state.completedAssistantIds : state.assistantIds).at(-1);
    if (lastAssistant) {
      const message = await read(api.session.message.get({ sessionID: sessionId, messageID: lastAssistant }, request));
      if (message.id !== lastAssistant || message.type !== "assistant") throw new Error("V2 returned a mismatched assistant message");
      assistant = message;
      const normalized = normalizeMessage(message, sessionId, messageId);
      snapshot.result = normalized; snapshot.text = formatMessageResponse(normalized);
    }
    let status: JobStatus = "unknown";
    if (state.outcome === "completed") {
      if (assistant && typeof assistant.time.completed === "number") status = "completed";
      else snapshot.error = { name: "MissingCorrelatedResult", message: "Execution ended but its completed assistant result is not available yet." };
    } else if (state.outcome) { status = state.outcome; if (state.error) snapshot.error = state.error; }
    else if (state.ownershipLost) snapshot.error = { name: "TurnOwnershipLost", message: "Another input owns the session; this job cannot claim its output or control it." };
    else if (state.interruption) snapshot.error = { name: "ExecutionInterrupted", reason: state.interruption,
      message: "Execution was interrupted by the backend; observe for recovery without resubmitting." };
    else if (state.queued) status = "accepted";
    else if (state.ownsExecution) {
      status = "running";
      const [forms, permissions] = await Promise.all([
        read(api.session.form.list({ sessionID: sessionId }, request)),
        read(api.permission.list({ sessionID: sessionId }, request)),
      ]);
      snapshot.inputs = [
        ...forms.filter(form => form.sessionID === sessionId).map(form => ({ ...form, kind: "question" as const, backend: "v2" })),
        ...permissions.filter(permission => permission.sessionID === sessionId).map(permission => ({ ...permission,
          kind: "permission" as const, backend: "v2", permission: permission.action, patterns: permission.resources,
          always: permission.save, approvalScope: "project", projectID: session.projectID })),
      ];
      if (snapshot.inputs.length) status = "input_required";
    }
    snapshot.status = status;
    return { snapshot, state };
  } catch (error) {
    // Cursor/correlation survives outages and deadlines. Never replay a write
    // or infer failure from a queued message's absent history projection.
    snapshot.status = "unknown";
    snapshot.error = { name: error instanceof Error ? error.name : "ObservationError",
      message: "V2 observation is incomplete; observe this job again without resubmitting." };
    return { snapshot, state };
  } finally { context.dispose(); }
}
