/** Bridge-owned contracts. Backend raw values are always explicitly labeled. */
export type BackendKind = "v1" | "v2";
export interface BackendIdentity {
  kind: BackendKind;
  resolved?: false;
  version?: string;
  connectionSource: "explicit" | "loopback" | "discovered" | "owned-child";
  processOwnership: "external" | "shared" | "owned";
  survivesDisconnect: boolean;
}
export interface Page<T> { items: T[]; complete: boolean; cursor?: string }
export interface BackendRaw { backend: BackendKind; value: unknown }
export interface Session extends Record<string, unknown> { id: string; title?: string; parentID?: string; directory?: string; time: { created: number; updated: number }; model?: { providerID: string; modelID: string; variant?: string }; agent?: string; raw?: BackendRaw }
export interface Message extends Record<string, unknown> { info: { id: string; sessionID: string; role: string; parentID?: string; time: { created: number; completed?: number }; finish?: string; error?: unknown }; parts: Array<{ type: string; text?: string; [key: string]: unknown }>; raw?: BackendRaw }
export class BackendCapabilityError extends Error {
  readonly code = "UNSUPPORTED_CAPABILITY";
  constructor(public readonly capability: string, message: string, public readonly backend: BackendKind = "v2") { super(message); this.name = "BackendCapabilityError"; }
}
export interface FileEntry extends Record<string, unknown> { path: string; type: "file" | "directory"; name?: string; raw?: BackendRaw }
export interface FileContent extends Record<string, unknown> { type: "text" | "binary"; content: string; encoding?: "base64"; backend?: BackendKind }
export interface FileStatus extends Record<string, unknown> { file: string; additions: number; deletions: number; status: string; raw?: BackendRaw }
export interface ProviderModel { id: string; name: string; limit?: {context:number;input?:number;output:number}; status?: string; enabled?: boolean }
export interface Provider extends Record<string, unknown> { id: string; name: string; integrationID?: string; activation?: string; configured?: boolean; source?: string; models: Record<string, ProviderModel>; raw?: BackendRaw }
export interface Providers extends Record<string, unknown> { all: Provider[]; connected: string[]; default: Record<string,string> }
export interface Permission extends Record<string, unknown> { id: string; sessionID: string; permission: string; patterns: string[]; always?: string[]; backend?: BackendKind; approvalScope?: "project"; rejectionScope?: "session"; raw?: BackendRaw }
export interface PromptSelection { model?: {providerID:string;modelID:string}; variant?: string; agent?: string }
export interface SessionCreate extends PromptSelection { title?: string; parentID?: string }
export interface Prompt extends PromptSelection { messageID?: string; parts?: Array<{type:"text";text:string}>; format?: unknown; system?: string; noReply?: boolean }
export type InputValues = Record<string,string|number|boolean|string[]>;
export interface InputResponse { answers?:string[][]; values?:InputValues; sessionId?:string }
export interface PermissionResponse { reply?:"once"|"always"|"reject"; scope?:"project"|"session"; message?:string; sessionId?:string }
export interface ConfigurationSources { backend:"v2"; sources:unknown[]; effectiveConfiguration:false }
export interface Project extends Record<string, unknown> { id:string; directory?:string; worktree?:string; name?:string; raw?:BackendRaw }
