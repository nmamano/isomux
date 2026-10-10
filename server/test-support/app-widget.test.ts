import { afterEach, expect, it } from "bun:test";
import { anOfficeWithAnApp } from "./app-host-test-kit.ts";
import type { TestServer } from "./harness.ts";
import { appRegistry, appRegistrationGeneration } from "../app-registry.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { mintApiToken } from "../api-tokens.ts";
import type { AppWidgetStatus } from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
afterEach(async () => { await server?.stop(); server = null; });

it("checks member and remote API access, hides targets, and refuses agent identities", async () => {
  const { srv, rawSessionId, token } = await anOfficeWithAnApp((s) => { server = s; });
  const app = appRegistry.get("hello")!;
  const registration = appRegistrationGeneration(app);
  const path = `/api/apps/hello/widget?registration=${registration}`;
  const response = await srv.http(path, { rawSessionId });
  expect(response.status).toBe(200);
  const status = await response.json() as AppWidgetStatus;
  expect(status.registration).toBe(registration);
  expect(status.sessionExpiresAt).toBeNull();
  expect(status.chat?.agentId).toBe(app.createdByAgentId);
  expect(status.appUrl).toBe(`https://${app.hostLabel}.office.example`);
  const member = getUserByName("Member")!;
  const api = await mintApiToken({ userId: member.id, name: "widget", expiresInDays: null });
  const apiResponse = await srv.http(path, { headers: { Authorization: `Bearer ${api.token}` } });
  expect(apiResponse.status).toBe(200);
  expect(await apiResponse.json()).toEqual(status);
  expect((await srv.http(path, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(403);

  appRegistry.update("hello", { messageTargetAgentId: app.createdByAgentId });
  const hiddenBefore = await srv.http("/api/apps/missing/widget?registration=1", { rawSessionId });
  const missingBody = await hiddenBefore.json();
  const stale = await srv.http(`/api/apps/hello/widget?registration=${registration + 1}`, { rawSessionId });
  expect(stale.status).toBe(404);
  expect(await stale.json()).toEqual(missingBody);
  updateUserById(member.id, { allowedRooms: [] });
  const hidden = await srv.http(path, { rawSessionId });
  expect(hidden.status).toBe(404);
  expect(await hidden.json()).toEqual(missingBody);
});

it("omits all target details when the target room is unavailable", async () => {
  const { srv, rawSessionId } = await anOfficeWithAnApp((s) => { server = s; });
  const app = appRegistry.get("hello")!;
  const room = srv.agentManager.createRoom("Hidden target");
  const target = await srv.agentManager.spawn("Hidden", srv.stateRoot, "default", undefined, undefined, room, undefined, undefined, undefined, undefined, "claude");
  expect(target).toBeTruthy();
  expect(getUserByName("Member")!.allowedRooms).not.toContain(room);
  appRegistry.update("hello", { messageTargetAgentId: target!.id });
  const response = await srv.http(`/api/apps/hello/widget?registration=${appRegistrationGeneration(app)}`, { rawSessionId });
  expect(response.status).toBe(200);
  const status = await response.json() as AppWidgetStatus;
  expect(status.chat).toBeNull();
  expect(JSON.stringify(status)).not.toContain(target!.id);
  expect(JSON.stringify(status)).not.toContain(target!.name);
});

it("serves a private wrapper only after office sign-in and app access", async () => {
  const { srv, rawSessionId } = await anOfficeWithAnApp((s) => { server = s; });
  const { raw, OFFICE_HOST, NAVIGATION_HEADERS } = await import("./app-host-test-kit.ts");
  const { HOST_COOKIE_NAME } = await import("../auth.ts");
  const fetchPage = (path: string, cookie?: string) => raw(srv.port, {
    host: OFFICE_HOST, path, headers: { ...NAVIGATION_HEADERS, ...(cookie ? {Cookie:`${HOST_COOKIE_NAME}=${cookie}`} : {}) },
  });
  const signedOut = await fetchPage("/hello");
  const unknownSignedOut = await fetchPage("/unknown");
  expect(signedOut.status).toBe(unknownSignedOut.status);
  expect(signedOut.body).toBe(unknownSignedOut.body);
  expect(signedOut.body).not.toContain("isomux-app-widget");
  const wrapper = await fetchPage("/hello?view=details", rawSessionId);
  expect(wrapper.status).toBe(200);
  expect(wrapper.body).toContain('name="isomux-app-widget"');
  expect(wrapper.headers["cache-control"]).toBe("no-store");
  expect(wrapper.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(wrapper.headers["content-security-policy"]).toContain("https://*.office.example");
  const outsider = await srv.seedMember("Outsider");
  const hidden = await fetchPage("/hello", outsider.rawSessionId);
  const missing = await fetchPage("/unknown", outsider.rawSessionId);
  const office = await fetchPage("/", outsider.rawSessionId);
  expect(hidden.status).toBe(office.status);
  expect(hidden.body).toBe(office.body);
  expect(hidden.body).toBe(missing.body);
  expect(hidden.body).not.toContain("isomux-app-widget");
});

it("checks app context at send time and derives member provenance from the app", async () => {
  const { srv, rawSessionId, token } = await anOfficeWithAnApp((s) => { server = s; });
  const app = appRegistry.get("hello")!;
  const target = app.createdByAgentId!;
  const context = { name: app.name, registration: appRegistrationGeneration(app) };
  const send = async (appContext: unknown, bearer?: string) => {
    const response = await srv.http(`/api/agents/${target}/messages`, {
      method:"POST", rawSessionId:bearer ? undefined : rawSessionId,
      headers:{"Content-Type":"application/json", ...(bearer ? {Authorization:`Bearer ${bearer}`} : {})},
      body:JSON.stringify({text:"Widget message",appContext}),
    });
    return {status:response.status,body:await response.json()};
  };
  expect((await send(context, token)).status).toBe(403);
  expect((await send({name:"hello",registration:"bad"})).status).toBe(422);
  const missing = await send({name:"missing",registration:1});
  expect(missing.status).toBe(404);
  expect((await send({...context,registration:context.registration+1})).body).toEqual(missing.body);
  const hiddenRoom = srv.agentManager.createRoom("Private");
  const hiddenAgent = await srv.agentManager.spawn("Private agent",srv.stateRoot,"default",undefined,undefined,hiddenRoom);
  const privateApp = appRegistry.register({name:"private",command:"bun app.ts",cwd:srv.stateRoot,userId:getUserByName("Boss")!.id,username:"Boss",createdBy:"Private agent",createdByAgentId:hiddenAgent!.id});
  const hidden = await send({name:privateApp.name,registration:appRegistrationGeneration(privateApp)});
  expect(hidden.status).toBe(404);
  expect(hidden.body).toEqual(missing.body);
  appRegistry.update("hello",{messageTargetAgentId:hiddenAgent!.id});
  const changed = await send(context);
  expect(changed.status).toBe(409);
  expect(changed.body.error.code).toBe("app_target_changed");
  appRegistry.update("hello",{messageTargetAgentId:target});
  expect((await send(context)).status).toBe(200);
  const entry = srv.agentManager.getAgentLogs(target).find((item)=>item.kind==="user_message" && item.content==="Widget message");
  expect(entry?.metadata?.username).toBe("Member");
  expect(entry?.metadata?.device).toBe("App hello");
  expect(srv.fakeBackend.sessions.flatMap(session=>session.sent).some(message=>message.text.startsWith("[Member (App hello)]"))).toBe(true);
  const api = await mintApiToken({userId:getUserByName("Member")!.id,name:"Widget API",expiresInDays:null});
  expect((await send(context,api.token)).status).toBe(200);
  const apiEntry=srv.agentManager.getAgentLogs(target).filter(item=>item.kind==="user_message" && item.content==="Widget message").at(-1);
  expect(apiEntry?.metadata?.device).toContain("; App hello");
  expect(apiEntry?.metadata?.device).toContain(api.apiToken.id);
});

it("refuses an image send when the app target changes after upload", async () => {
  const {srv,rawSessionId}=await anOfficeWithAnApp(s=>{server=s;});
  const app=appRegistry.get("hello")!;
  const original=srv.agentManager.getAgent(app.createdByAgentId!)!;
  const replacement=await srv.agentManager.spawn("New image target",srv.stateRoot,"default",undefined,undefined,original.roomId);
  const form=new FormData();form.append("file",new File(["image bytes"],"shot.png",{type:"image/png"}));
  const uploaded=await srv.http(`/api/upload/${original.id}`,{method:"POST",rawSessionId,body:form});
  expect(uploaded.status).toBe(200);
  const {attachments}=await uploaded.json();
  expect(attachments).toHaveLength(1);
  appRegistry.update(app.name,{messageTargetAgentId:replacement!.id});
  const sent=await srv.http(`/api/agents/${original.id}/messages`,{method:"POST",rawSessionId,headers:{"Content-Type":"application/json"},body:JSON.stringify({text:"Old target image",attachments,appContext:{name:app.name,registration:appRegistrationGeneration(app)}})});
  expect(sent.status).toBe(409);
  expect((await sent.json()).error.code).toBe("app_target_changed");
  expect(srv.agentManager.getAgentLogs(replacement!.id).filter(entry=>entry.kind==="user_message")).toHaveLength(0);
  expect(srv.agentManager.getAgentLogs(original.id).filter(entry=>entry.kind==="user_message")).toHaveLength(0);
});
