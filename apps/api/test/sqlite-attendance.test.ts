import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { SqliteLocalDatabase } from "../src/infra/sqlite/local-database.js";
import { SqliteInboundEventStore } from "../src/infra/sqlite/sqlite-inbound-event-store.js";
import { createMetaSignature } from "../src/meta/signature.js";
import { testConfig } from "./helpers.js";
import { vi } from "vitest";

type App = Awaited<ReturnType<typeof buildApp>>;
type Session = { cookie:string; csrfToken:string };
const openApps = new Set<App>();
const directories:string[] = [];

afterEach(async () => {
  for (const app of openApps) await app.close();
  openApps.clear();
  for (const directory of directories.splice(0)) await rm(directory, {recursive:true,force:true});
});

async function filename() {
  const directory = await mkdtemp(join(tmpdir(), "atende-http-sqlite-"));
  directories.push(directory);
  return join(directory, "test.sqlite");
}

async function start(path:string) {
  const database = new SqliteLocalDatabase(path);
  const store = new SqliteInboundEventStore(database);
  const app = await buildApp({config:{...testConfig, localDemoEnabled:true, localSqlitePath:path},store,localDatabase:database,logger:false});
  openApps.add(app);
  await app.ready();
  await app.localAttendanceService!.stopWorker();
  return app;
}

async function stop(app:App) { await app.close(); openApps.delete(app); }
async function login(app:App,email="admin@atende.local"):Promise<Session> {
  const response=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{email,password:"AtendeLocal123!"}});
  expect(response.statusCode).toBe(200);
  const cookie = response.headers["set-cookie"];
  return {cookie:(Array.isArray(cookie)?cookie[0]:cookie)!.split(";")[0]!,csrfToken:response.json().csrfToken};
}
function headers(session:Session) {return {cookie:session.cookie,"x-csrf-token":session.csrfToken};}
async function simulate(app:App,session:Session,tenant:string,clientMessageId:string,text="atendente") {
  return app.inject({method:"POST",url:`/api/v1/tenants/${tenant}/simulate`,headers:headers(session),payload:{customerName:"Cliente persistente",customerPhone:"5511990001111",text,clientMessageId}});
}
async function postSignedWebhook(app:App,phoneNumberId:string,eventId:string,customerPhone:string,tenantId?:string) {
  const rawBody=JSON.stringify({object:"whatsapp_business_account",tenant_id:tenantId,entry:[{changes:[{value:{tenant_id:tenantId,metadata:{phone_number_id:phoneNumberId},contacts:[{wa_id:customerPhone,profile:{name:"Meta test customer"}}],messages:[{id:eventId,from:customerPhone,timestamp:"1791028800",type:"text",text:{body:"Mensagem do número de teste"},tenant_id:tenantId}]}}]}]});
  return app.inject({method:"POST",url:"/webhooks/meta",headers:{"content-type":"application/json","x-hub-signature-256":createMetaSignature(Buffer.from(rawBody),"app-secret")},payload:rawBody});
}
async function queue(app:App,session:Session,tenant="pizzaria-demo") {
  const response=await app.inject({url:`/api/v1/tenants/${tenant}/conversations`,headers:headers(session)});
  expect(response.statusCode).toBe(200);
  return response.json().conversations as Array<{id:string;state:string;assignedUserId:string|null}>;
}

describe("local SQLite HTTP restart", () => {
  it("rolls back a failed channel binding in both the snapshot and live channel routing",async()=>{
    const path=await filename();
    const database=new SqliteLocalDatabase(path); const store=new SqliteInboundEventStore(database);
    const app=await buildApp({config:{...testConfig,localDemoEnabled:true},store,localDatabase:database,logger:false});
    openApps.add(app); await app.ready(); await app.localAttendanceService!.stopWorker();
    const admin=await login(app);
    const before=database.attendanceRepository.load()!;
    const oldPhoneNumberId=before.tenants.find(entry=>entry.tenant.id==="pizzaria-demo")!.tenant.channelPhoneNumberId;
    const save=vi.spyOn(database.attendanceRepository,"save").mockImplementationOnce(()=>{throw new Error("snapshot failure");});
    const failed=await app.inject({method:"PUT",url:"/api/v1/tenants/pizzaria-demo/channel",headers:headers(admin),payload:{phoneNumberId:"123456789012345"}});
    save.mockRestore();
    expect(failed.statusCode).toBe(500);
    expect(database.attendanceRepository.load()).toEqual(before);
    expect((await app.inject({url:"/api/v1/tenants/pizzaria-demo/config",headers:headers(admin)})).json().tenant.channelPhoneNumberId).toBe(oldPhoneNumberId);

    const oldChannelEvent=await postSignedWebhook(app,oldPhoneNumberId,"rollback-old-channel","5511990002222");
    expect(oldChannelEvent.headers["x-webhook-enqueued"]).toBe("1");
    await app.localAttendanceService!.processPending();
    expect((await queue(app,admin,"pizzaria-demo")).map(conversation=>conversation.state)).toEqual(["WAITING_HUMAN"]);
  });

  it("rolls back tenant creation and live state when membership storage fails",async()=>{
    const path=await filename();
    const database=new SqliteLocalDatabase(path); const store=new SqliteInboundEventStore(database);
    const app=await buildApp({config:{...testConfig,localDemoEnabled:true},store,localDatabase:database,logger:false});
    openApps.add(app); await app.ready(); await app.localAttendanceService!.stopWorker();
    const admin=await login(app);
    const before=database.attendanceRepository.load();
    const save=vi.spyOn(database.identityRepository,"save").mockImplementationOnce(()=>{throw new Error("disk failure");});
    const response=await app.inject({method:"POST",url:"/api/v1/tenants",headers:headers(admin),payload:{displayName:"Não deve existir",segment:"outro"}});
    save.mockRestore(); expect(response.statusCode).toBe(500);
    expect(database.attendanceRepository.load()).toEqual(before);
    const tenants=await app.inject({url:"/api/v1/tenants",headers:headers(admin)});
    expect(tenants.json().tenants).toHaveLength(2);
    expect(app.localAttendanceService!.listTenants(database.attendanceRepository.load()!.tenants.map(entry=>entry.tenant.id))).toHaveLength(2);
    const retry=await app.inject({method:"POST",url:"/api/v1/tenants",headers:headers(admin),payload:{displayName:"Pode existir",segment:"outro"}});
    expect(retry.statusCode).toBe(201);
    expect((await app.inject({url:"/api/v1/tenants",headers:headers(admin)})).json().tenants).toHaveLength(3);
  });
  it("preserves tenant, configuration, membership, session, history and human assignment",async()=>{
    const path=await filename(); let app=await start(path); const admin=await login(app);
    const created=await app.inject({method:"POST",url:"/api/v1/tenants",headers:headers(admin),payload:{displayName:"Oficina persistente",segment:"outro"}});
    expect(created.statusCode).toBe(201); const tenantId=created.json().tenant.id;
    const current=await app.inject({url:`/api/v1/tenants/${tenantId}/config`,headers:headers(admin)});
    const config=current.json().config;
    expect(config.knowledge).toEqual([]);
    expect((await app.inject({method:"PUT",url:`/api/v1/tenants/${tenantId}/config`,headers:headers(admin),payload:{...config,greeting:"Olá da oficina persistente"}})).statusCode).toBe(200);
    expect((await simulate(app,admin,tenantId,"durable-1")).statusCode).toBe(202);
    await app.localAttendanceService!.processPending(); const conversation=(await queue(app,admin,tenantId))[0]!;
    const base=`/api/v1/tenants/${tenantId}/conversations/${conversation.id}`;
    expect((await app.inject({method:"POST",url:`${base}/claim`,headers:headers(admin)})).statusCode).toBe(200);
    expect((await app.inject({method:"POST",url:`${base}/reply`,headers:headers(admin),payload:{text:"Resposta preservada"}})).json().message.deliveryStatus).toBe("SIMULATED");
    await stop(app); app=await start(path);
    expect((await app.inject({url:"/api/v1/auth/me",headers:headers(admin)})).statusCode).toBe(200);
    const restored=await app.inject({url:base,headers:headers(admin)});
    expect(restored.statusCode).toBe(200);
    expect(restored.json().conversation).toMatchObject({state:"HUMAN_ACTIVE",assignedUserId:"admin-demo"});
    expect(restored.json().messages.map((message:{text:string})=>message.text)).toEqual(["atendente","Resposta preservada"]);
    const savedConfig=await app.inject({url:`/api/v1/tenants/${tenantId}/config`,headers:headers(admin)});
    expect(savedConfig.json().config).toMatchObject({version:2,greeting:"Olá da oficina persistente"});
    expect((await app.inject({method:"POST",url:`${base}/close`,headers:headers(admin)})).statusCode).toBe(200);
    expect((await app.inject({method:"POST",url:"/api/v1/auth/logout",headers:headers(admin)})).statusCode).toBe(204);
    await stop(app); app=await start(path);
    expect((await app.inject({url:"/api/v1/auth/me",headers:headers(admin)})).statusCode).toBe(401);
    const newLogin=await login(app);
    expect((await queue(app,newLogin,tenantId))[0]!.state).toBe("CLOSED");
  });

  it("recovers pending events after restart and preserves inbound deduplication",async()=>{
    const path=await filename(); let app=await start(path); const admin=await login(app);
    expect((await simulate(app,admin,"pizzaria-demo","recover-1","oi")).statusCode).toBe(202);
    expect(await queue(app,admin)).toEqual([]);
    await stop(app); app=await start(path); await app.localAttendanceService!.processPending();
    const conversation=(await queue(app,admin))[0]!;
    const repeated=await simulate(app,admin,"pizzaria-demo","recover-1","oi");
    expect(repeated.json().status).toBe("DUPLICATE");
    await app.localAttendanceService!.processPending();
    const detail=await app.inject({url:`/api/v1/tenants/pizzaria-demo/conversations/${conversation.id}`,headers:headers(admin)});
    expect(detail.json().messages).toHaveLength(2);
    expect(detail.json().messages[1]).toMatchObject({role:"BOT",deliveryStatus:"SIMULATED"});
  });

  it("preserves tenant isolation and independent simulator identifiers across restarts",async()=>{
    const path=await filename(); let app=await start(path); const admin=await login(app); const pizza=await login(app,"pizzaria@atende.local");
    expect((await simulate(app,admin,"pizzaria-demo","same-id")).statusCode).toBe(202);
    expect((await simulate(app,admin,"barbearia-demo","same-id")).statusCode).toBe(202);
    await app.localAttendanceService!.processPending();
    const barber=(await queue(app,admin,"barbearia-demo"))[0]!;
    await stop(app); app=await start(path);
    expect((await queue(app,pizza)).length).toBe(1);
    expect((await app.inject({url:"/api/v1/tenants/barbearia-demo/config",headers:headers(pizza)})).statusCode).toBe(403);
    expect((await app.inject({url:`/api/v1/tenants/pizzaria-demo/conversations/${barber.id}`,headers:headers(pizza)})).statusCode).toBe(404);
  });

  it("persists a test channel binding and routes signed incoming messages after restart",async()=>{
    const path=await filename(); let app=await start(path); let admin=await login(app);
    expect((await simulate(app,admin,"pizzaria-demo","before-channel-binding","Oi")).statusCode).toBe(202);
    await app.localAttendanceService!.processPending();
    const existing=(await queue(app,admin,"pizzaria-demo"))[0]!;
    const phoneNumberId="223456789012345678";
    const bound=await app.inject({method:"PUT",url:"/api/v1/tenants/pizzaria-demo/channel",headers:headers(admin),payload:{phoneNumberId}});
    expect(bound.statusCode).toBe(200);
    expect((await app.inject({url:"/api/v1/tenants/pizzaria-demo/config",headers:headers(admin)})).json().tenant.channelPhoneNumberId).toBe(phoneNumberId);
    await stop(app); app=await start(path); admin=await login(app);

    const webhook=await postSignedWebhook(app,phoneNumberId,"wamid-after-channel-binding","5511990003333","barbearia-demo");
    expect(webhook.statusCode).toBe(200); expect(webhook.headers["x-webhook-enqueued"]).toBe("1");
    await app.localAttendanceService!.processPending();
    const pizzaConversations=await queue(app,admin,"pizzaria-demo");
    expect(pizzaConversations).toHaveLength(2);
    expect(pizzaConversations.some(conversation=>conversation.id===existing.id)).toBe(true);
    expect((await queue(app,admin,"barbearia-demo")).some(conversation=>conversation.id===existing.id)).toBe(false);
    const boundConversation=pizzaConversations.find(conversation=>conversation.id!==existing.id)!;
    const detail=await app.inject({url:`/api/v1/tenants/pizzaria-demo/conversations/${boundConversation.id}`,headers:headers(admin)});
    expect(detail.json().conversation).toMatchObject({tenantId:"pizzaria-demo",customerPhone:"5511990003333"});
  });

  it("rejects unknown signed channels and reports persistent simulated mode",async()=>{
    const path=await filename(); const app=await start(path);
    const info=await app.inject({url:"/api/v1/system/info"});
    expect(info.json()).toMatchObject({eventStore:"sqlite",attendancePersistence:"sqlite",outboundMode:"simulated",whatsappOutboundEnabled:false});
    const payload=JSON.stringify({object:"whatsapp_business_account",entry:[{changes:[{value:{metadata:{phone_number_id:"unknown"},messages:[{id:"signed-unknown",from:"5511990001111",timestamp:"1791028800",type:"text",text:{body:"oi"}}]}}]}]});
    const response=await app.inject({method:"POST",url:"/webhooks/meta",headers:{"content-type":"application/json","x-hub-signature-256":createMetaSignature(Buffer.from(payload),"app-secret")},payload});
    expect(response.statusCode).toBe(200); expect(response.headers["x-webhook-enqueued"]).toBe("0");
    const session=await login(app); await app.localAttendanceService!.processPending();
    expect(await queue(app,session)).toEqual([]);
  });
});
