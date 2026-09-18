import type { SessionInfo } from "@opencode/client";
import { BackendCapabilityError } from "./contracts.js";
export interface PromptOptions { model?: { providerID: string; modelID: string }; variant?: string; agent?: string; format?: unknown; system?: string; noReply?: boolean }
export function assertPromptOptions(body: PromptOptions): void {
  for (const field of ["agent", "variant"] as const) if (body[field] !== undefined && !body[field]?.trim()) throw new Error(`V2 ${field} must be a nonempty string`);
  if (body.model && (!body.model.providerID?.trim() || !body.model.modelID?.trim())) throw new Error("V2 model selection requires nonempty providerID and modelID");
  if (body.format && (body.format as {type?:string}).type !== "text") throw new BackendCapabilityError("prompt.format", "V2 cannot guarantee JSON-schema output; format must be omitted or text.");
  if (body.system) throw new BackendCapabilityError("prompt.system", "V2 does not support a per-prompt system override.");
  if (body.noReply === true) throw new BackendCapabilityError("prompt.noReply", "V2 cannot guarantee noReply: true.");
}
export function assertSessionSelection(session: SessionInfo, body: PromptOptions): void {
  assertPromptOptions(body);
  if (body.model && (body.model.providerID !== session.model?.providerID || body.model.modelID !== session.model?.id)) throw new BackendCapabilityError("session.model", "Existing V2 sessions preserve their model; create a new session to select a different model.");
  if (body.variant !== undefined && body.variant !== session.model?.variant) throw new BackendCapabilityError("session.variant", "Existing V2 sessions preserve their model variant.");
  if (body.agent !== undefined && body.agent !== session.agent) throw new BackendCapabilityError("session.agent", "Existing V2 sessions preserve their agent.");
}

/** Upstream 2.0.6 prompt/compact implicitly commit staged reverts. Never trigger that hidden write. */
export function assertNoStagedRevert(session: SessionInfo): void {
  if (session.revert) throw new BackendCapabilityError("session.staged_revert", "V2 2.0.6 would automatically commit this staged revert when prompting or compacting. Clear it with session_unrevert, or explicitly commit it outside this bridge, before continuing.");
}
