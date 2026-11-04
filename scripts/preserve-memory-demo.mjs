// One-time transition from the existing memory demo. Never overwrites a database.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const projectRoot=resolve(fileURLToPath(new URL("..",import.meta.url)));
const databasePath=resolve(projectRoot,".data/attendance.sqlite");
const backupPath=resolve(projectRoot,`.data/memory-transition-${Date.now()}.json`);
const base="http://127.0.0.1:3000";
let cookie;
let csrfToken;
async function request(path,options={}) {
  const response=await fetch(`${base}${path}`,{...options,headers:{...(cookie?{cookie}:{}),...options.headers},signal:AbortSignal.timeout(5000)});
  if(!response.ok) throw new Error(`Transição local: HTTP ${response.status}.`);
  if(path==="/api/v1/auth/login") cookie=response.headers.get("set-cookie")?.split(";")[0];
  return response.status===204?undefined:response.json();
}
try {
  if(existsSync(databasePath)) throw new Error("O banco de destino já existe. Nenhum dado foi substituído.");
  const info=await request("/api/v1/system/info");
  if(!info.localDemoEnabled||info.eventStore!=="memory") throw new Error("Origem não é a demonstração local em memória.");
  const session=await request("/api/v1/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"admin@atende.local",password:"AtendeLocal123!"})});
  csrfToken=session.csrfToken;
  const {tenants}=await request("/api/v1/tenants");
  const snapshot={tenants:[],conversations:[],messages:[],processedInboundIds:[]};
  for(const tenant of tenants) {
    const path=`/api/v1/tenants/${encodeURIComponent(tenant.id)}`;
    snapshot.tenants.push(await request(`${path}/config`));
    const {conversations}=await request(`${path}/conversations`);
    for(const conversation of conversations) {
      const detail=await request(`${path}/conversations/${encodeURIComponent(conversation.id)}`);
      snapshot.conversations.push(detail.conversation);
      snapshot.messages.push(...detail.messages);
    }
  }
  mkdirSync(resolve(projectRoot,".data"),{recursive:true});
  writeFileSync(backupPath,JSON.stringify({exportedAt:new Date().toISOString(),source:"memory-demo",snapshot},null,2),{flag:"wx",mode:0o600});
  const requireFromApi=createRequire(resolve(projectRoot,"apps/api/package.json"));
  const {register}=requireFromApi("tsx/esm/api");
  register();
  const {SqliteLocalDatabase}=await import("../apps/api/src/infra/sqlite/local-database.ts");
  const {LocalSessionManager}=await import("../apps/api/src/auth/local-sessions.ts");
  const database=new SqliteLocalDatabase(databasePath);
  try {
    database.transaction(()=>{
      database.attendanceRepository.save(snapshot);
      const identities=new LocalSessionManager(Date.now,database.identityRepository);
      for(const membership of session.user.memberships) identities.addMembership("admin-demo",membership.tenantId,membership.role);
      identities.close();
    });
  } finally {database.close();}
  console.log(`Preservados ${snapshot.tenants.length} clientes, ${snapshot.conversations.length} conversas e ${snapshot.messages.length} mensagens em SQLite.`);
  console.log(`Cópia de segurança do estado anterior: ${backupPath}`);
  console.log("Sessões e IDs antigos de deduplicação não estavam expostos pela API em memória; não foram migrados. Entre novamente no painel.");
} catch(error) {console.error(error.message);process.exitCode=1;}
finally {
  if(cookie&&csrfToken) await request("/api/v1/auth/logout",{method:"POST",headers:{"x-csrf-token":csrfToken}}).catch(()=>{});
}
