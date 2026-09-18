import { registerSessionTools } from "../src/tools/session.js";
import type { McpServer } from "../src/mcp-server.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { OpenCodeClient, OpenCodeError, OpenCodeSubmissionError } from "../src/client.js";
import { backend, events, operate, selectModel } from "../src/backends/adapter.js";
import { setModelDefaults, safeStringify, toolResult } from "../src/helpers.js";
import { BackendCapabilityError } from "../src/backends/contracts.js";
import { validateFormValues, nativeFormSchema } from "../src/backends/v2-forms.js";
import { translateMcpConfig } from "../src/backends/v2-mcp.js";
import { decodeInputResponses } from "../src/task-input.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { setModelDefaults(); await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
const defaultLocation = {directory:"/server/project",project:{id:"prj",directory:"/server/project",canonical:"/server/project"}};
const session = (overrides: Record<string,unknown> = {}) => ({ id: "ses_a", title: "Example", location: {directory:"/server/project"}, projectID:"prj_a", model:{providerID:"p",id:"m",variant:"fast"}, agent:"build", time:{created:1,updated:2}, cost:0,tokens:{}, ...overrides });
type Call = {method:string;url:URL;body:any};
async function fixture(handler: (call: Call, res: ServerResponse) => unknown, prefix = "") {
  const calls:Call[] = [];
  const server = createServer(async (req:IncomingMessage,res:ServerResponse) => {
    const chunks:Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text=Buffer.concat(chunks).toString();const call={method:req.method!,url:new URL(req.url!,"http://fixture"),body:text ? JSON.parse(text) : undefined};calls.push(call);
    res.setHeader("content-type","application/json");
    try { const value=await handler(call,res); if(!res.writableEnded && !res.destroyed) res.end(JSON.stringify(value ?? {})); }
    catch { res.statusCode=500;res.end('{}'); }
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  cleanups.push(()=>new Promise(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  const address=server.address() as {port:number};
  return {calls,client:new OpenCodeClient({baseUrl:`http://127.0.0.1:${address.port}${prefix}`,backend:"v2"})};
}

describe("V2 actual SDK HTTP contracts",()=>{
  it.each(["/bridge","/api"])("preserves authoritative base URL prefix %s",async prefix=>{
    const {client,calls}=await fixture(()=>({version:"2.0.6",pid:1,urls:[],paths:{tmp:"/tmp"}}),prefix);
    await expect(operate(client,"lifecycle.health")).resolves.toMatchObject({healthy:true,backend:"v2"});
    expect(calls[0].url.pathname).toBe(prefix+"/api/info");
  });
  it("preserves remote Windows paths and creates model/agent before prompting",async()=>{
    const {client,calls}=await fixture(({body})=>({data:session({location:body.location,model:body.model,agent:body.agent})}));
    const result=await operate(client,"sessions.create",{directory:"\\\\server\\share\\project",body:{model:{providerID:"p",modelID:"m"},variant:"fast",agent:"plan"}});
    expect(calls).toHaveLength(1);expect(calls[0].body).toEqual({model:{providerID:"p",id:"m",variant:"fast"},agent:"plan",location:{directory:"\\\\server\\share\\project"}});
    expect(result.directory).toBe("\\\\server\\share\\project");
  });
  it.each([400,401,403])("keeps explicit write rejection HTTP %i definite",async status=>{
    const {client,calls}=await fixture((_,res)=>{res.statusCode=status;return {message:"rejected"};});
    await expect(operate(client,"sessions.create",{body:{title:"test"}})).rejects.toMatchObject({name:"OpenCodeError",status});
    expect(calls).toHaveLength(1);
  });
  it("keeps a lost write response ambiguous without replay",async()=>{
    const {client,calls}=await fixture((_,res)=>res.destroy());
    await expect(operate(client,"sessions.create",{body:{title:"test"}})).rejects.toBeInstanceOf(OpenCodeSubmissionError);
    expect(calls).toHaveLength(1);
  });
  it("rejects pre-cancelled writes without dispatch",async()=>{
    const {client,calls}=await fixture(()=>session());const controller=new AbortController();controller.abort();
    await expect(operate(client,"sessions.create",{signal:controller.signal,body:{title:"test"}})).rejects.toMatchObject({name:"AbortError"});expect(calls).toHaveLength(0);
  });
  it.each([{format:{type:"json_schema",schema:{}}},{system:"override"},{noReply:true}])("rejects unsupported prompt guarantee before any HTTP request: %j",async guard=>{
    const {client,calls}=await fixture(()=>session());
    await expect(operate(client,"messages.enqueue",{sessionId:"ses_a",body:{parts:[{type:"text",text:"test"}],...guard}})).rejects.toBeInstanceOf(BackendCapabilityError);expect(calls).toHaveLength(0);
  });
  it("rejects parent creation and variant without model before writes",async()=>{
    const {client,calls}=await fixture(()=>session());
    await expect(operate(client,"sessions.create",{body:{parentID:"ses_a"}})).rejects.toBeInstanceOf(BackendCapabilityError);
    await expect(operate(client,"sessions.create",{body:{variant:"fast"}})).rejects.toBeInstanceOf(BackendCapabilityError);expect(calls).toHaveLength(0);
  });
  it("preserves existing session selection and queues the exact prompt identity",async()=>{
    const {client,calls}=await fixture(({method,body})=>method==="GET"?{data:session()}:{data:{id:body.id,sessionID:"ses_a",type:"user",delivery:body.delivery}});
    const receipt=await operate(client,"messages.enqueue",{sessionId:"ses_a",body:{messageID:"msg_assigned",parts:[{type:"text",text:"hello"}],model:{providerID:"p",modelID:"m"},variant:"fast",agent:"build"}});
    expect(receipt?.id).toBe("msg_assigned");expect(calls[1].body).toEqual({id:"msg_assigned",text:"hello",delivery:"queue"});
    await expect(operate(client,"messages.enqueue",{sessionId:"ses_a",body:{model:{providerID:"other",modelID:"m"}}})).rejects.toBeInstanceOf(BackendCapabilityError);
    expect(calls.filter(call=>call.method!=="GET")).toHaveLength(1);
  });
  it("rejects mismatched receipt as unknown and never retries",async()=>{
    const {client,calls}=await fixture(({method})=>method==="GET"?{data:session()}:{data:{id:"msg_wrong",sessionID:"ses_a"}});
    await expect(operate(client,"messages.enqueue",{sessionId:"ses_a",body:{messageID:"msg_expected",parts:[{type:"text",text:"hello"}]}})).rejects.toBeInstanceOf(OpenCodeSubmissionError);
    expect(calls.filter(call=>call.method==="POST")).toHaveLength(1);
  });
  it("does not apply defaults to existing V2 sessions or accept half a model selection",async()=>{
    const {client}=await fixture(()=>session());setModelDefaults("default","default-model");
    expect(selectModel(client)).toBeUndefined();expect(selectModel(client,undefined,undefined,true)).toEqual({providerID:"default",modelID:"default-model"});
    expect(()=>selectModel(client,"explicit")).toThrow("both providerID and modelID");
  });
  it("returns explicit pagination while preserving a caller limit",async()=>{
    const {client,calls}=await fixture(({url})=>url.pathname==="/api/location"?defaultLocation:({data:[session({id:url.searchParams.get("cursor")?"ses_b":"ses_a"})],cursor:{next:url.searchParams.get("cursor")?null:"next-page"}}));
    const result=await operate(client,"sessions.list",{query:{limit:"1"}});
    expect(result).toHaveLength(1);expect(calls.filter(call=>call.url.pathname==="/api/session")).toHaveLength(1);
    expect(toolResult("sessions",false,{data:result}).structuredContent).toMatchObject({complete:false,cursor:"next-page"});
    expect(JSON.parse(safeStringify(result))).toMatchObject({complete:false,cursor:"next-page"});
    const continued=await operate(client,"sessions.list",{query:{limit:"1",cursor:"next-page"}});expect(continued[0].id).toBe("ses_b");
  });
  it.each(["0","-1","1.5"])("rejects invalid pagination limit %s",async limit=>{
    const {client,calls}=await fixture(({url})=>url.pathname==="/api/location"?defaultLocation:({data:[],cursor:{}}));await expect(operate(client,"sessions.list",{query:{limit}})).rejects.toThrow("positive integer");expect(calls.every(call=>call.url.pathname==="/api/location")).toBe(true);
  });
  it("reads every page when no limit is requested",async()=>{
    const {client,calls}=await fixture(({url})=>url.pathname==="/api/location"?defaultLocation:({data:[session({id:url.searchParams.has("cursor")?"ses_b":"ses_a"})],cursor:{next:url.searchParams.has("cursor")?null:"next"}}));
    expect(await operate(client,"sessions.list")).toHaveLength(2);expect(calls.filter(call=>call.url.pathname==="/api/session")).toHaveLength(2);
  });
  it("refuses wrong session directory before read or mutation",async()=>{
    const {client,calls}=await fixture(({url})=>url.pathname==="/api/location"?{directory:"/elsewhere",project:{id:"prj",directory:"/elsewhere",canonical:"/elsewhere"}}:{data:session()});
    await expect(operate(client,"sessions.remove",{sessionId:"ses_a",directory:"/elsewhere"})).rejects.toThrow("does not match");expect(calls.every(call=>call.method==="GET")).toBe(true);
    await expect(operate(client,"messages.list",{sessionId:"ses_a",directory:"/elsewhere"})).rejects.toThrow("does not match");
  });
  it("requires an explicit diff range and never commits a staged revert",async()=>{
    const {client,calls}=await fixture(({method})=>method==="GET"?{data:session()}:{data:{messageID:"msg_a"}});
    await expect(operate(client,"sessions.diff",{sessionId:"ses_a"})).rejects.toThrow("explicit from and to");
    await expect(operate(client,"sessions.revert",{sessionId:"ses_a",body:{messageID:"msg_a",partID:"part_a"}})).rejects.toBeInstanceOf(BackendCapabilityError);
    expect(calls).toHaveLength(0);
    await expect(operate(client,"sessions.revert",{sessionId:"ses_a",body:{messageID:"msg_a"}})).resolves.toMatchObject({committed:false,reversible:true});
    expect(calls.filter(call=>call.method==="POST").map(call=>call.url.pathname)).toEqual(["/api/session/ses_a/revert/stage"]);
  });
  it("requires explicit project/session permission scope before mutation",async()=>{
    const {client,calls}=await fixture(({method},res)=>{if(method==="GET")return {data:session()};res.statusCode=204;});
    await expect(operate(client,"permissions.reply",{sessionId:"ses_a",requestId:"perm_a",body:{reply:"always"}})).rejects.toThrow("scope: project");
    await expect(operate(client,"permissions.reply",{sessionId:"ses_a",requestId:"perm_a",body:{reply:"reject"}})).rejects.toThrow("scope: session");expect(calls).toHaveLength(0);
    await operate(client,"permissions.reply",{sessionId:"ses_a",requestId:"perm_a",body:{reply:"always",scope:"project"}});expect(calls.at(-1)?.body).toEqual({decision:"always"});
  });
  it("blocks uncorrelatable commands before submission",async()=>{
    const {client,calls}=await fixture(()=>({}));await expect(operate(client,"messages.command",{sessionId:"ses_a",body:{command:"test"}})).rejects.toThrow("no command was submitted");expect(calls).toHaveLength(0);
  });
  it("requires exact OAuth attempt identity before global auth writes",async()=>{
    const {client,calls}=await fixture(()=>({}));await expect(operate(client,"providers.callback",{providerId:"p",body:{method:0}})).rejects.toThrow("attemptId");expect(calls).toHaveLength(0);
  });
});

describe("V2 forms and configuration contracts",()=>{
  const fields:any=[{key:"count",type:"integer",required:true,minimum:1},{key:"approve",type:"boolean",required:true},{key:"choices",type:"multiselect",options:[{value:"a",label:"A"}],maxItems:1}];
  it("validates typed native/manual values against the same schema",()=>{
    expect(validateFormValues(fields,{count:2,approve:false,choices:["a"]})).toEqual({count:2,approve:false,choices:["a"]});
    expect(()=>validateFormValues(fields,{count:"2",approve:true})).toThrow();expect(()=>validateFormValues(fields,{count:2,approve:true,choices:["other"]})).toThrow();
    expect(()=>validateFormValues(fields,{count:2,approve:true,unknown:"x"})).toThrow();
  });
  it("uses manual fallback for forms MCP cannot represent faithfully",()=>{
    expect(nativeFormSchema([{key:"x",type:"string",pattern:"^[a-z]+$"}])).toBeUndefined();
    expect(nativeFormSchema([{key:"x",type:"multiselect",custom:true,options:[]}])).toBeUndefined();
    expect(nativeFormSchema([{key:"x",type:"external",url:"https://example.com"}])).toBeUndefined();
  });
  it("never interprets declining permission elicitation as a session rejection",()=>{
    expect(decodeInputResponses([{id:"p",kind:"permission",backend:"v2",sessionID:"ses_a"}],{"permission:p":{action:"decline"}})).toEqual([]);
    expect(decodeInputResponses([{id:"f",kind:"question",backend:"v2",sessionID:"ses_a",fields}],{"question:f":{action:"decline"}})).toEqual([{id:"f",kind:"question",reject:true}]);
    expect(()=>decodeInputResponses([{id:"p",kind:"permission",backend:"v2",sessionID:"ses_a"}],{"permission:p":{action:"accept",content:{decision:"always",scope:"session"}}})).toThrow();
  });
  it("translates supported MCP fields and rejects conflicts or unsupported fields",()=>{
    expect(translateMcpConfig({type:"remote",url:"https://example.com",enabled:true,timeout:1000,oauth:{clientId:"client"}})).toMatchObject({disabled:false,timeout:{catalog:1000,execution:1000},oauth:{client_id:"client"}});
    expect(()=>translateMcpConfig({type:"local",command:["test"],enabled:true,disabled:true})).toThrow("Conflicting");
    expect(()=>translateMcpConfig({type:"local",command:["test"],unknown:true})).toThrow("Unsupported");
  });
});

describe("V2 normalized reads and scoped mutations over HTTP",()=>{
  it("joins provider models and integrations without treating activation as a credential",async()=>{
    const {client,calls}=await fixture(({url})=>({location:{directory:"/server/project"},data:
      url.pathname==="/api/provider"?[{id:"p",name:"Configured",integrationID:"i",activation:"enabled"},{id:"q",name:"Unconfigured",activation:"enabled"}]:
      url.pathname==="/api/model"?[{id:"m",name:"Model",providerID:"p",enabled:true,status:"active",limit:{context:100,output:10}}]:
      [{id:"i",name:"Integration",connections:[{id:"credential"}],methods:[]}]}));
    const result=await operate(client,"providers.configured");expect(result.providers.map(provider=>provider.id)).toEqual(["p"]);expect(result.providers[0].models.m.name).toBe("Model");
    expect(calls.map(call=>call.url.pathname)).toEqual(["/api/provider","/api/model","/api/integration"]);
  });
  it("does not make further provider reads after authentication failure",async()=>{
    const {client,calls}=await fixture((_,res)=>{res.statusCode=401;return {};});await expect(operate(client,"providers.list")).rejects.toMatchObject({status:401});expect(calls).toHaveLength(1);
  });
  it("preserves ordered configuration sources without inventing an effective merge",async()=>{
    const sources=[{type:"document",path:"global.json",info:{model:"p/a"}},{type:"document",path:"project.json",info:{model:"p/b"}}];
    const {client}=await fixture(()=>sources);await expect(operate(client,"configuration.get")).resolves.toEqual({backend:"v2",sources,effectiveConfiguration:false});
  });
  it("normalizes text and binary file reads without resolving paths locally",async()=>{
    const {client,calls}=await fixture(({url},res)=>{res.setHeader("content-type","application/octet-stream");res.end(url.pathname.endsWith("/binary")?Buffer.from([0xff,0xfe]):Buffer.from("hello"));});
    await expect(operate(client,"files.read",{query:{path:"file.txt"},directory:"C:\\remote\\project"})).resolves.toMatchObject({type:"text",content:"hello"});
    await expect(operate(client,"files.read",{query:{path:"binary"},directory:"C:\\remote\\project"})).resolves.toMatchObject({type:"binary",encoding:"base64",content:"//4="});
    expect(calls[0].url.searchParams.get("location[directory]")).toBe("C:\\remote\\project");
  });
  it("marks bounded file searches without inventing continuation",async()=>{
    const {client}=await fixture(()=>({location:{directory:"/project"},data:[{path:"one",type:"file"},{path:"two",type:"file"}]}));
    const results=await operate(client,"files.find",{query:{query:"o",limit:"2"}});expect(toolResult("files",false,{data:results}).structuredContent).toMatchObject({complete:false,continuationAvailable:false,bounded:true});
  });
  it("reports model and agent conflicts without changing settings",async()=>{
    const {client,calls}=await fixture(()=>({data:session()}));
    await expect(operate(client,"messages.enqueue",{sessionId:"ses_a",body:{agent:"plan"}})).rejects.toThrow("preserve their agent");
    await expect(operate(client,"messages.enqueue",{sessionId:"ses_a",body:{variant:"slow"}})).rejects.toThrow("preserve their model variant");expect(calls.every(call=>call.method==="GET")).toBe(true);
  });
  it("preserves explicit fork-before boundary",async()=>{
    const {client,calls}=await fixture(({url,method})=>({data:method==="POST"?session({id:"ses_fork"}):url.pathname.endsWith("/message/msg_boundary")?{id:"msg_boundary",type:"user",text:"boundary",time:{created:1}}:session()}));
    const result=await operate(client,"sessions.fork",{sessionId:"ses_a",body:{messageID:"msg_boundary"}});
    expect(result.forkBoundary).toEqual({type:"before",messageId:"msg_boundary"});expect(calls.at(-1)?.body).toEqual({before:"msg_boundary"});
  });
  it("rejects cross-location diff ranges and discloses turn attribution",async()=>{
    let crossed=true;
    const {client,calls}=await fixture(({url})=>url.pathname.endsWith("/message")?{data:[{id:"msg_a",type:"user",text:"A",time:{created:1}},...(crossed?[{id:"msg_move",type:"location-switched",time:{created:2}}]:[]),{id:"msg_b",type:"user",text:"B",time:{created:3}}],cursor:{}}:url.pathname.endsWith("/diff")?{data:[{file:"a",before:"",after:"x",additions:1,deletions:0}]}:{data:session()});
    await expect(operate(client,"sessions.diff",{sessionId:"ses_a",query:{from:"msg_a",to:"msg_b"}})).rejects.toThrow("cross-location");expect(calls.some(call=>call.url.pathname.endsWith("/diff"))).toBe(false);
    crossed=false;const diff=await operate(client,"sessions.diff",{sessionId:"ses_a",query:{from:"msg_a",to:"msg_b"}});expect(toolResult("diff",false,{data:diff}).structuredContent).toMatchObject({attribution:"turn",range:{from:"msg_a",to:"msg_b"}});
  });
  it("validates field-keyed form values before replying",async()=>{
    const form={id:"form_a",sessionID:"ses_a",title:"Count",fields:[{key:"count",type:"integer",required:true,minimum:1}],state:{status:"pending"}};
    const {client,calls}=await fixture(({url,method},res)=>{if(method==="POST"){res.statusCode=204;return;}return {data:url.pathname.endsWith("/form/form_a")?form:session()};});
    await expect(operate(client,"forms.reply",{sessionId:"ses_a",requestId:"form_a",body:{values:{count:"3"}}})).rejects.toThrow("Invalid value");expect(calls.every(call=>call.method==="GET")).toBe(true);
    await operate(client,"forms.reply",{sessionId:"ses_a",requestId:"form_a",body:{values:{count:3}}});expect(calls.at(-1)?.body).toEqual({answer:{count:3}});
  });
  it("carries the exact OAuth attempt and rejects ambiguous integration mappings",async()=>{
    let mapped=true;
    const {client,calls}=await fixture(({url,method},res)=>{
      if(url.pathname==="/api/provider")return {data:[{id:"p",name:"Provider",integrationID:mapped?"integration_a":undefined}]};
      if(url.pathname==="/api/integration")return {data:[{id:"integration_a",name:"Integration",connections:[],methods:[{id:"oauth_a",type:"oauth",label:"Sign in"}]}]};
      if(url.pathname.endsWith("/oauth"))return {data:{attemptID:"attempt_exact",url:"https://example.com",instructions:"Enter code",mode:"code",time:{created:1,expires:2}}};
      if(method==="POST"){res.statusCode=204;return;}
    });
    const authorization=await operate(client,"providers.authorize",{providerId:"p",body:{methodId:"oauth_a"}}) as any;
    expect(authorization.attemptId).toBe("attempt_exact");
    await operate(client,"providers.callback",{providerId:"p",body:{attemptId:"attempt_exact",code:"code"}});
    expect(calls.at(-1)?.url.pathname).toContain("attempt_exact");
    mapped=false;const prior=calls.filter(call=>call.method==="POST").length;await expect(operate(client,"providers.authorize",{providerId:"p",body:{method:0}})).rejects.toThrow("unambiguous");expect(calls.filter(call=>call.method==="POST")).toHaveLength(prior);
  });
  it("observes shell completion and reports nonzero exit instead of submission success",async()=>{
    let assigned="",reads=0;
    const {client,calls}=await fixture(({url,method,body},res)=>{
      if(method==="POST"){assigned=body.id;res.statusCode=204;return;}
      if(url.pathname.includes("/message/")) { if(reads++===0){res.statusCode=404;return{};}return{data:{id:assigned,type:"shell",command:"false",shellID:"sh_a",status:"exited",exit:1,time:{created:1,completed:2},output:{output:"failed",cursor:1,size:6,truncated:false}}}; }
      return{data:session()};
    });
    const result=await operate(client,"messages.shell",{sessionId:"ses_a",body:{command:"false",agent:"build"}});expect(result.isError).toBe(true);expect(result.info.id).toBe(assigned);expect(result.parts[0].text).toContain("failed");expect(calls.filter(call=>call.method==="POST")).toHaveLength(1);
  });
  it("filters project events by actual server location and releases the stream",async()=>{
    const {client}=await fixture(({url},res)=>{
      if(url.pathname==="/api/location")return{directory:"/canonical/project",project:{id:"prj",directory:"/canonical/project",canonical:"/canonical/project"}};
      res.setHeader("content-type","text/event-stream");res.end([{type:"server.connected"},{type:"session.created",location:{directory:"/other"},data:{}},{type:"session.updated",location:{directory:"/canonical/project"},data:{}}].map(event=>`data: ${JSON.stringify(event)}\n\n`).join(""));
    });
    const received=[];for await(const event of events(client,"project",{directory:"/server/alias",timeout:1000})){received.push(event);break;}
    expect(received.map(event=>event.event)).toEqual(["session.updated"]);
  });
});

describe("V2 completion and location boundary regressions",()=>{
  it("treats a failed observation after successful mutation as unknown with recovery identity",async()=>{
    let patched=false;
    const {client}=await fixture(({method},res)=>{if(method==="PATCH"){patched=true;res.statusCode=204;return;}if(patched){res.statusCode=503;return{};}return{data:session()};});
    await expect(operate(client,"sessions.update",{sessionId:"ses_a",body:{title:"new title"}})).rejects.toMatchObject({name:"OpenCodeSubmissionError",sessionId:"ses_a"});
  });
  it("retains assigned shell identity when post-submission observation fails",async()=>{
    let assigned="";
    const {client}=await fixture(({method,url,body},res)=>{if(method==="POST"){assigned=body.id;res.statusCode=204;return;}if(url.pathname.includes("/message/")){res.statusCode=503;return{};}return{data:session()};});
    await expect(operate(client,"messages.shell",{sessionId:"ses_a",body:{command:"pwd",agent:"build"}})).rejects.toMatchObject({name:"OpenCodeSubmissionError",sessionId:"ses_a",messageId:expect.stringMatching(/^msg_/)});expect(assigned).toMatch(/^msg_/);
  });
  it("keeps default project sessions and statuses scoped to the resolved location",async()=>{
    const {client,calls}=await fixture(({url})=>{
      if(url.pathname==="/api/location")return defaultLocation;
      if(url.pathname==="/api/session")return{data:[session()],cursor:{}};
      if(url.pathname==="/api/session/active")return{data:{ses_a:{type:"running"},ses_other:{type:"running"}}};
      return{data:session({id:url.pathname.endsWith("ses_other")?"ses_other":"ses_a",location:{directory:url.pathname.endsWith("ses_other")?"/other/project":"/server/project"}})};
    });
    expect(await operate(client,"sessions.list")).toHaveLength(1);expect(calls.find(call=>call.url.pathname==="/api/session")?.url.searchParams.get("directory")).toBe("/server/project");
    expect(await operate(client,"sessions.status")).toEqual({ses_a:{type:"running"}});
  });
  it("uses compaction queue delivery and preserves the existing selection",async()=>{
    const {client,calls}=await fixture(({method,body})=>method==="GET"?{data:session()}:{data:{id:"inbox_compaction",sessionID:"ses_a",type:"compaction",delivery:body.delivery}});
    await operate(client,"sessions.compact",{sessionId:"ses_a",body:{providerID:"p",modelID:"m",variant:"fast"}});expect(calls.at(-1)?.body).toEqual({delivery:"queue"});
    await expect(operate(client,"sessions.compact",{sessionId:"ses_a",body:{providerID:"other",modelID:"m"}})).rejects.toBeInstanceOf(BackendCapabilityError);expect(calls.filter(call=>call.method==="POST")).toHaveLength(1);
  });
  it("maps normalized tool content without inventing message parentage",async()=>{
    const {client}=await fixture(()=>({data:[{id:"msg_a",type:"user",text:"work",time:{created:1}},{id:"msg_b",type:"assistant",agent:"build",model:{providerID:"p",id:"m"},time:{created:2,completed:3},content:[{type:"tool",id:"call_a",name:"read",state:{status:"completed",input:{file:"x"},content:[{type:"text",text:"contents"}]},time:{created:2}}]}],cursor:{}}));
    const messages=await operate(client,"messages.list",{sessionId:"ses_a"});expect(messages[1].info.parentID).toBeUndefined();expect(messages[1].parts[0]).toMatchObject({type:"tool",tool:"read",callID:"call_a"});expect(messages[1].raw?.backend).toBe("v2");
  });
});

describe("V1 mutation fallback characterization",()=>{
  it.each([401,403,500,"lost"] as const)("does not replay permission responses after %s",async status=>{
    const {client:connection,calls}=await fixture((_,res)=>{if(status==="lost"){res.destroy();return;}res.statusCode=status;return {error:"rejected"};});
    const client=new OpenCodeClient({baseUrl:connection.getBaseUrl(),backend:"v1"});
    const handlers=new Map<string,Function>();registerSessionTools({tool:(...args:unknown[])=>handlers.set(String(args[0]),args.at(-1) as Function)} as unknown as McpServer,client);
    const result=await handlers.get("opencode_session_permission")!({id:"ses_a",permissionID:"perm_a",reply:"once"});
    expect(result.isError).toBe(true);expect(calls).toHaveLength(1);expect(calls[0].url.pathname).toBe("/permission/perm_a/reply");
  });
});

describe("public V2 preflight arguments",()=>{
  it.each([
    ["opencode_session_create",{parentID:""}],
    ["opencode_session_revert",{id:"ses_a",messageID:"msg_a",partID:""}],
    ["opencode_session_create",{agent:""}],
    ["opencode_session_create",{variant:""}],
    ["opencode_session_create",{providerID:"",modelID:""}],
  ] as const)("does not discard unsupported empty arguments in %s",async(name,args)=>{
    const {client,calls}=await fixture(()=>({data:session()}));const handlers=new Map<string,Function>();
    registerSessionTools({tool:(...values:unknown[])=>handlers.set(String(values[0]),values.at(-1) as Function)} as unknown as McpServer,client);
    const result=await handlers.get(name)!(args);expect(result.isError).toBe(true);expect(calls).toHaveLength(0);
  });
});

describe("V2 upstream implicit mutation safeguards",()=>{
  it.each(["messages.send","messages.enqueue","sessions.compact"] as const)("refuses %s while a reversible revert is staged",async operation=>{
    const {client,calls}=await fixture(()=>({data:session({revert:{messageID:"msg_a"}})}));
    await expect(operate(client,operation,{sessionId:"ses_a",body:{}})).rejects.toMatchObject({code:"UNSUPPORTED_CAPABILITY",capability:"session.staged_revert"});
    expect(calls.map(call=>call.method)).toEqual(["GET"]);
  });
});
