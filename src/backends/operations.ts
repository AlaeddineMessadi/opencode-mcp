import type { RequestOptions } from "../async.js";
import type { Operation } from "./v1-routes.js";
import type { Session, Message, SessionCreate, Prompt, Providers, Provider, FileEntry, FileContent, FileStatus, Permission, PermissionResponse, InputResponse, ConfigurationSources, Project } from "./contracts.js";
/** Inputs are named domain operations; transport paths never cross this boundary. */
export interface CommonInput extends RequestOptions { directory?:string; query?:Record<string,string>; sessionId?:string; messageId?:string; requestId?:string; providerId?:string }
type Input<B = never> = CommonInput & ([B] extends [never] ? {body?:never} : {body?:B});
interface Contract<I,O> { input:I; output:O }
interface Definitions {
  "lifecycle.health": Contract<Input, {healthy:boolean;version?:string;backend?:string}>;
  "configuration.get": Contract<Input, ConfigurationSources|Record<string,unknown>>;
  "configuration.agents": Contract<Input, Array<Record<string,unknown>>>;
  "configuration.commands": Contract<Input, Array<Record<string,unknown>>>;
  "configuration.mcp": Contract<Input, Record<string,unknown>>;
  "configuration.mcpAdd": Contract<Input<{name:string;config:Record<string,unknown>}>, unknown>;
  "projects.list": Contract<Input, Project[]>;
  "projects.current": Contract<Input, Project>;
  "files.paths": Contract<Input, Record<string,unknown>>;
  "files.vcs": Contract<Input, Record<string,unknown>>;
  "files.list": Contract<Input, FileEntry[]>;
  "files.read": Contract<Input, FileContent>;
  "files.find": Contract<Input, string[]>;
  "files.status": Contract<Input, FileStatus[]>;
  "providers.list": Contract<Input, Providers>;
  "providers.configured": Contract<Input, {providers:Provider[];default:Record<string,string>}>;
  "providers.authMethods": Contract<Input, Record<string,unknown>>;
  "providers.authorize": Contract<Input<{method?:number;inputs?:Record<string,string>;values?:import('./contracts.js').InputValues;integrationId?:string;methodId?:string}>, unknown>;
  "providers.callback": Contract<Input<{method?:number;code?:string;attemptId?:string;integrationId?:string}>, unknown>;
  "providers.setAuth": Contract<Input<{type:string;key:string;integrationId?:string}>, unknown>;
  "sessions.list": Contract<Input, Session[]>;
  "sessions.children": Contract<Input, Session[]>;
  "sessions.get": Contract<Input, Session>;
  "sessions.status": Contract<Input, Record<string,unknown>>;
  "sessions.create": Contract<Input<SessionCreate>, Session>;
  "sessions.update": Contract<Input<{title?:string}>, Session>;
  "sessions.remove": Contract<Input, unknown>;
  "sessions.abort": Contract<Input<Record<string,never>>, unknown>;
  "sessions.fork": Contract<Input<{messageID?:string}>, Session>;
  "sessions.compact": Contract<Input<{providerID?:string;modelID?:string;variant?:string}>, unknown>;
  "sessions.diff": Contract<Input, unknown[]>;
  "sessions.revert": Contract<Input<{messageID?:string;partID?:string}>, unknown>;
  "sessions.unrevert": Contract<Input, unknown>;
  "messages.list": Contract<Input, Message[]>;
  "messages.get": Contract<Input, Message>;
  "messages.send": Contract<Input<Prompt>, Message>;
  "messages.enqueue": Contract<Input<Prompt>, {id:string;sessionID:string}|undefined>;
  "messages.command": Contract<Input<{command?:string;arguments?:string;agent?:string;model?:string;variant?:string}>, unknown>;
  "messages.shell": Contract<Input<{command?:string;agent?:string;model?:Prompt['model']}>, Message & {isError?:boolean}>;
  "permissions.list": Contract<Input, Permission[]>;
  "permissions.reply": Contract<Input<PermissionResponse>, unknown>;
  "forms.list": Contract<Input, Array<{id:string;sessionID:string;[key:string]:unknown}>>;
  "forms.reply": Contract<Input<InputResponse>, unknown>;
  "forms.reject": Contract<Input, unknown>;
}
export type OperationInputs = {[K in Operation]: K extends keyof Definitions ? Definitions[K]["input"] : CommonInput & {body?:unknown}};
export type OperationResults = {[K in Operation]: K extends keyof Definitions ? Definitions[K]["output"] : unknown};
