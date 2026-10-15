import { fieldObjectReferences, validateWorkflowFile, workflowCategory } from "./management/railwayWorkflow.ts";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, realpathSync, writeFileSync, renameSync, unlinkSync, createReadStream } from "node:fs";
import { resolve,join,basename,sep } from "node:path";
import type { IncomingMessage,ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { MANAGEMENT_API,MANAGEMENT_COLLECTIONS, type ManagementCollection,type ManagementCommand,type ManagementRecord,type ManagementProject,type ManagementMember,type ManagementSnapshot,type ManagementRole,type ManagementSession,type ManagementFilters } from "../src/managementTypes.ts";
import { ManagementError,ensure,allow,str,id,ids,num,instant,rolePermissions,applyDomain,type Actor } from "./management/domain.ts";
import { authorizeRecord,canAccessRecord,authorizeCommand,type RecordSource } from "./management/authorization.ts";
import { validateEvidenceStorage } from "./management/evidenceStorage.ts";
import { checklistVersion } from "./management/checkIntegrity.ts";
import { createManagementEventBridge,readLegacyEvents } from "./management/eventBridge.ts";
import { validateIssueDiscovery,discoverySpatialId } from "./management/eventDiscovery.ts";
import { evaluateTaskConditions } from "./management/taskConditions.ts";
import { calculateMetrics } from "./management/metrics.ts";
import { createLibraryEvidenceResolver, type LibraryEvidence } from "./management/libraryEvidence.ts";
import { loadProjectModelRegistry } from "./safetySpatialStore.ts";
import type { ModelRegistryEntry } from "../src/safetySpatialTypes.ts";
import type { RailSafetyRecord } from "../src/railSafetyTypes.ts";
import { PositioningGateway, loadPositioningGatewayConfig, validatePositioningGatewayConfig, type PositioningGatewayConfig } from "./management/positioningGateway.ts";
export { ManagementError } from "./management/domain.ts";
export type ManagementStoreOptions={dataDir?:string;projectId?:string;projectName?:string;libraryDataDir?:string;spatialDataDir?:string;modelRegistry?:ModelRegistryEntry[]|(()=>Promise<ModelRegistryEntry[]>);localCompatibility?:boolean;now?:()=>string;positioningConfig?:PositioningGatewayConfig;
 resolveSpatialReference?:(projectId:string,objectId:string)=>unknown|Promise<unknown>;
 resolveLibraryEvidence?:(projectId:string,recordId:string,fileKey:string)=>LibraryEvidence|undefined|Promise<LibraryEvidence|undefined>};
type DbRow={data:string};
import { setManagementActor } from "./management/actorContext.ts";
export { managementActor } from "./management/actorContext.ts";
const COOKIE="cesium_management_session",SESSION_MS=8*60*60*1000;
const emptyCollections=()=>Object.fromEntries(MANAGEMENT_COLLECTIONS.map(k=>[k,[]])) as unknown as Record<ManagementCollection,ManagementRecord[]>;
const hash=(s:string|Buffer)=>createHash("sha256").update(s).digest("hex");
function output(res:ServerResponse,status:number,value:unknown){if(res.destroyed||res.headersSent)return;res.statusCode=status;res.setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(value));}
/** Geometry capabilities also govern nested historical records in reports and conflict details.
 * Return a detached public projection; domain reads and persisted resources retain the full value. */
function withoutUnauthorizedMachinery<T>(value:T,actor?:Actor):T{
 if(actor?.permissions.includes("models"))return value;
 const redact=(v:unknown):unknown=>Array.isArray(v)?v.filter(item=>!(item&&typeof item==="object"&&(item as {kind?:unknown}).kind==="railSafety")).map(redact):v&&typeof v==="object"?Object.fromEntries(Object.entries(v).filter(([key])=>key!=="machinery"&&key!=="definition"&&key!=="railSafetyRisk").map(([key,item])=>[key,redact(item)])):v;
 return redact(value) as T;
}
function publicError(error:unknown,actor?:Actor){return error instanceof ManagementError?new ManagementError(error.status,error.code,error.message,withoutUnauthorizedMachinery(error.details,actor),withoutUnauthorizedMachinery(error.current,actor)):error;}
function errorOutput(res:ServerResponse,error:unknown,actor?:Actor){const e=publicError(error instanceof ManagementError?error:new ManagementError(500,"INTERNAL_ERROR","管理服务失败，输入未写入，请重试"),actor) as ManagementError;output(res,e.status,{error:e.message,code:e.code,details:e.details,current:e.current});}
function loopback(req:IncomingMessage){return ["127.0.0.1","::1","::ffff:127.0.0.1"].includes(req.socket.remoteAddress||"");}
function sameOrigin(req:IncomingMessage){const origin=req.headers.origin;if(!origin)return;let host="";try{host=new URL(origin).host;}catch{/* denied */}if(!host||host!==req.headers.host)throw new ManagementError(403,"CROSS_ORIGIN","不允许跨站访问管理数据");}
function canonical(value:unknown):string{if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';return JSON.stringify(value);}
async function body(req:IncomingMessage,limit=1_048_576){let bytes=0;const chunks:Buffer[]=[];for await(const raw of req){const c=Buffer.from(raw);bytes+=c.length;if(bytes>limit)throw new ManagementError(413,"BODY_TOO_LARGE","请求超过大小限制");chunks.push(c);}return Buffer.concat(chunks);}
async function jsonBody(req:IncomingMessage){ensure(req.headers["content-type"]?.startsWith("application/json"),"CONTENT_TYPE","请求必须为JSON");try{return JSON.parse((await body(req)).toString("utf8"));}catch(e){if(e instanceof ManagementError)throw e;throw new ManagementError(400,"INVALID_JSON","JSON格式无效");}}
function requestMarker(req:IncomingMessage){if(req.headers["x-cesium-library"]!=="1")throw new ManagementError(403,"MISSING_REQUEST_MARKER","缺少同源业务请求标识");}
function passwordHash(password:string){const salt=randomBytes(16).toString("hex");return salt+":"+scryptSync(password,salt,64).toString("hex");}
function passwordMatches(password:string,saved:string){const [salt,value]=saved.split(":");const actual=scryptSync(password,salt,64);const expected=Buffer.from(value,"hex");return actual.length===expected.length&&timingSafeEqual(actual,expected);}

/** SQLite v1 is additive. Original library, media, model and spatial files are never migrated or rewritten. */
export function createManagementStore(options:ManagementStoreOptions={}){
 const root=resolve(options.dataDir||process.env.CESIUM_MANAGEMENT_DATA_DIR||process.env.CESIUM_DATA_DIR||join(process.cwd(),"project-data"));mkdirSync(root,{recursive:true});
 const legacyEventPath=join(options.spatialDataDir||process.env.CESIUM_SAFETY_DATA_DIR||root,"safety-events.json");
 const libraryRoot=resolve(options.libraryDataDir||process.env.CESIUM_DATA_DIR||join(process.cwd(),"project-data"));
 const legacyProjectId=options.projectId||"safety:project",now=options.now||(()=>new Date().toISOString());
 const positioning=new PositioningGateway(options.positioningConfig?validatePositioningGatewayConfig(options.positioningConfig):loadPositioningGatewayConfig(),()=>Date.parse(now()));
 const resolveLibraryEvidence=options.resolveLibraryEvidence||createLibraryEvidenceResolver(libraryRoot,legacyProjectId);
 const db=new DatabaseSync(join(root,"management.sqlite"));db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
 const version=Number((db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version);if(version>1){db.close();throw new ManagementError(500,"SCHEMA_UNSUPPORTED","管理数据库版本比应用更新，原库保留");}
 db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,display_name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS members(project_id TEXT NOT NULL,user_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(project_id,user_id));
 CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id));
 CREATE TABLE IF NOT EXISTS records(project_id TEXT NOT NULL,collection TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(project_id,collection,id));
 CREATE TABLE IF NOT EXISTS record_versions(project_id TEXT NOT NULL,collection TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,recorded_at TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(project_id,collection,id,revision));
 CREATE TABLE IF NOT EXISTS receipts(project_id TEXT NOT NULL,actor_id TEXT NOT NULL,key TEXT NOT NULL,signature TEXT NOT NULL,record_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(project_id,actor_id,key));
 CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,actor_id TEXT NOT NULL,command TEXT NOT NULL,record_id TEXT NOT NULL,before_revision INTEGER,after_revision INTEGER NOT NULL,at TEXT NOT NULL,reason TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS versions_asof ON record_versions(project_id,recorded_at);
 INSERT OR IGNORE INTO meta VALUES('revision','0'); PRAGMA user_version=1; COMMIT;`);
 if(!db.prepare("SELECT id FROM projects WHERE id=?").get(legacyProjectId)){const time=now();const project:ManagementProject={id:legacyProjectId,name:options.projectName||"邻近营业线施工项目",revision:1,timezone:"Asia/Shanghai",calendar:{workingDays:[1,2,3,4,5,6]},horizontalCrs:"待核验（沿用当前模型）",verticalDatum:"待核验",units:"m",isTest:false,createdAt:time,updatedAt:time};db.prepare("INSERT INTO projects VALUES(?,?)").run(project.id,JSON.stringify(project));}
 let queue:Promise<unknown>=Promise.resolve(),closed=false;
 const revision=()=>Number((db.prepare("SELECT value FROM meta WHERE key='revision'").get() as {value:string}).value);
 const usersExist=()=>Number((db.prepare("SELECT count(*) AS n FROM users").get() as {n:number}).n)>0;
 const localActor=():Actor=>({id:"local-owner",displayName:"本机所有者（未启用账号）",roles:["owner"],permissions:[...rolePermissions.owner],authMode:"local-owner"});
 function getProject(projectId:string){const row=db.prepare("SELECT data FROM projects WHERE id=?").get(id(projectId)) as DbRow|undefined;if(!row)throw new ManagementError(404,"PROJECT_NOT_FOUND","项目不存在");return JSON.parse(row.data) as ManagementProject;}
 function businessDate(projectId:string,at=now()){return new Intl.DateTimeFormat("en-CA",{timeZone:getProject(projectId).timezone,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(at));}
 function getMember(projectId:string,userId:string){const row=db.prepare("SELECT data FROM members WHERE project_id=? AND user_id=?").get(projectId,userId) as DbRow|undefined;return row?JSON.parse(row.data) as ManagementMember:undefined;}
 function accountActor(userId:string,projectId:string,expiresAt?:string):Actor{const user=db.prepare("SELECT active,display_name FROM users WHERE id=?").get(userId) as {active:number;display_name:string}|undefined;const member=getMember(projectId,userId);if(!user?.active||!member?.active)throw new ManagementError(403,"PROJECT_FORBIDDEN","账号没有此项目权限");
  const permissions=[...new Set(member.roles.flatMap(r=>rolePermissions[r]))].filter(p=>!["models","files","media"].includes(p)||member.resourceAccess[p as "models"|"files"|"media"]&&(p!=="models"||member.taskIds===undefined));
  return {id:userId,displayName:member.displayName,roles:member.roles,permissions,authMode:"local-account",taskIds:member.taskIds,expiresAt};}
 function authenticate(req:IncomingMessage,projectId=legacyProjectId):Actor{getProject(projectId);const match=req.headers.cookie?.split(";").map(v=>v.trim()).find(v=>v.startsWith(COOKIE+"="));if(match){const token=match.slice(COOKIE.length+1);const row=db.prepare("SELECT user_id,expires_at FROM sessions WHERE token_hash=?").get(hash(token)) as {user_id:string;expires_at:string}|undefined;if(!row||row.expires_at<=now())throw new ManagementError(401,"SESSION_EXPIRED","本机会话已失效，请重新登录");return accountActor(row.user_id,projectId,row.expires_at);}
  if(!usersExist()&&options.localCompatibility!==false&&loopback(req)&&["localhost","127.0.0.1","[::1]"].includes(new URL("http://"+(req.headers.host||"invalid")).hostname))return localActor();throw new ManagementError(401,"AUTH_REQUIRED",usersExist()?"已启用本机账号，请先登录":"远程访问需先在本机建立账号");}
 function recordSource(projectId:string):RecordSource{return{get:(kind,key)=>get(projectId,kind,key),list:kind=>list(projectId,kind)};}
 function visible(actor:Actor,record:ManagementRecord,kind:ManagementCollection){return canAccessRecord(actor,kind,record,recordSource(record.projectId));}
 function authorizedGet(projectId:string,actor:Actor,kind:ManagementCollection,key:string){const record=get(projectId,kind,key);authorizeRecord(actor,kind,record,recordSource(projectId));return record;}
 function publicRecord(kind:ManagementCollection,record:ManagementRecord,actor:Actor){return withoutUnauthorizedMachinery(kind==="checks"?{...record,checklistVersion:checklistVersion(record)}:record,actor);}

 function list(projectId:string,kind:ManagementCollection):ManagementRecord[]{return (db.prepare("SELECT data FROM records WHERE project_id=? AND collection=? ORDER BY rowid").all(projectId,kind) as DbRow[]).map(r=>JSON.parse(r.data));}
 function get(projectId:string,kind:ManagementCollection,key:string){const row=db.prepare("SELECT data FROM records WHERE project_id=? AND collection=? AND id=?").get(projectId,kind,key) as DbRow|undefined;if(!row)throw new ManagementError(404,"RECORD_NOT_FOUND","记录不存在");return JSON.parse(row.data) as ManagementRecord;}
 function collections(projectId:string,actor:Actor,F?:string){const out=emptyCollections();const rows=F?db.prepare(`SELECT v.collection,v.data FROM record_versions v WHERE v.project_id=? AND v.recorded_at<=? AND v.revision=(SELECT max(x.revision) FROM record_versions x WHERE x.project_id=v.project_id AND x.collection=v.collection AND x.id=v.id AND x.recorded_at<=?)`).all(projectId,F,F):db.prepare("SELECT collection,data FROM records WHERE project_id=?").all(projectId);
  for(const row of rows as {collection:ManagementCollection;data:string}[]){const record=JSON.parse(row.data) as ManagementRecord;if(visible(actor,record,row.collection))out[row.collection].push(publicRecord(row.collection,record,actor));}return out;}
 function publicSession(actor:Actor):ManagementSession{return {userId:actor.id,displayName:actor.displayName,roles:actor.roles,authMode:actor.authMode,permissions:actor.permissions,expiresAt:actor.expiresAt};}
 function snapshot(projectId:string,actor:Actor):ManagementSnapshot{getProject(projectId);allow(actor,"read");const projects=(db.prepare("SELECT data FROM projects").all() as DbRow[]).map(v=>JSON.parse(v.data) as ManagementProject).filter(p=>actor.authMode==="local-owner"||getMember(p.id,actor.id)?.active);
  const members=(db.prepare("SELECT data FROM members WHERE project_id=?").all(projectId) as DbRow[]).map(v=>JSON.parse(v.data) as ManagementMember).filter(m=>actor.permissions.includes("admin")||m.id===actor.id||!actor.taskIds);
  const audit=actor.taskIds?[]:(db.prepare("SELECT * FROM audit WHERE project_id=? ORDER BY id DESC LIMIT 200").all(projectId) as Record<string,unknown>[]).map(v=>({id:Number(v.id),projectId:String(v.project_id),actorId:String(v.actor_id),command:String(v.command),recordId:String(v.record_id),beforeRevision:v.before_revision===null?null:Number(v.before_revision),afterRevision:Number(v.after_revision),at:String(v.at),reason:String(v.reason)}));
  return {schemaVersion:1,revision:revision(),projectId,session:publicSession(actor),projects,members,collections:collections(projectId,actor),updatedAt:now(),audit};}
 function storeRecord(projectId:string,kind:ManagementCollection,record:ManagementRecord){db.prepare("INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(project_id,collection,id) DO UPDATE SET revision=excluded.revision,data=excluded.data").run(projectId,kind,record.id,record.revision,JSON.stringify(record));db.prepare("INSERT INTO record_versions VALUES(?,?,?,?,?,?)").run(projectId,kind,record.id,record.revision,record.updatedAt,JSON.stringify(record));}
 function validateEvidence(projectId:string,key:string){validateEvidenceStorage(get(projectId,"evidence",key),root,libraryRoot,Boolean(options.resolveLibraryEvidence));}
 function authorizeEvidence(projectId:string,actor:Actor,key:string){const e=authorizedGet(projectId,actor,"evidence",key);allow(actor,e.storageName?"files":e.requiredPermission==="media"?"media":e.requiredPermission==="models"?"models":"files");validateEvidence(projectId,key);}

 async function resolveArea(projectId:string,key:string){let object:Record<string,unknown>|undefined,ledgerVersion:number|null=null,ledgerRevision:number|null=null;
  if(options.resolveSpatialReference)object=await options.resolveSpatialReference(projectId,key) as Record<string,unknown>|undefined;
  else{ensure(projectId===legacyProjectId,"SPATIAL_PROJECT_UNAVAILABLE","此项目尚未接入空间台账");const file=join(options.spatialDataDir||process.env.CESIUM_SAFETY_DATA_DIR||root,"safety-spatial.json");ensure(existsSync(file),"SPATIAL_SOURCE_UNAVAILABLE","空间台账尚未接入");const data=JSON.parse(readFileSync(file,"utf8"));object=(data.objects||[]).find((o:{id:string})=>o.id===key);ledgerVersion=Number.isSafeInteger(data.version)&&data.version>0?data.version:null;ledgerRevision=Number.isSafeInteger(data.revision)&&data.revision>=0?data.revision:null;}
  ensure(object&&object.id===key&&object.projectId===projectId&&!object.archived&&!object.deletedAt&&["construction-area","railway","risk-point"].includes(String(object.kind)),"SPATIAL_NOT_FOUND","所选用户几何不存在、已停用或不属于此项目");
  const revision=Number.isSafeInteger(object.revision)&&Number(object.revision)>0?Number(object.revision):null;
  // Capture the exact server-read source; a later point edit must never rewrite historical business references.
  return {...structuredClone(object),reference:{kind:"spatial",id:key,projectId,revision,revisionStatus:revision===null?"historical-unnumbered":"numbered",ledgerVersion,ledgerRevision,
   geometrySha256:object.geometry===undefined?null:hash(canonical(object.geometry)),sourceSha256:object.source===undefined?null:hash(canonical(object.source))}};}

 function bump(){db.prepare("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();}
 function audit(projectId:string,actor:Actor,m:ManagementCommand,key:string,before:number|null,after:number,time:string){db.prepare("INSERT INTO audit(project_id,actor_id,command,record_id,before_revision,after_revision,at,reason) VALUES(?,?,?,?,?,?,?,?)").run(projectId,actor.id,m.type,key,before,after,time,String(m.payload.reason||m.payload.basis||"").slice(0,4000));}
 function fresh(actor:Actor,projectId:string){if(actor.authMode==="local-account")return accountActor(actor.id,projectId,actor.expiresAt);if(usersExist())throw new ManagementError(401,"AUTH_REQUIRED","本机账号已启用，请登录后继续");return actor;}
 async function execute(m:ManagementCommand,providedActor:Actor):Promise<ManagementSnapshot>{
  ensure(m&&typeof m==="object"&&m.payload&&typeof m.payload==="object"&&!Array.isArray(m.payload),"INVALID_COMMAND","业务命令格式无效");id(m.projectId,"项目");id(m.idempotencyKey,"幂等键");str(m.type,"业务命令",80);ensure(canonical(m).length<=1_000_000,"BODY_TOO_LARGE","业务记录过大");getProject(m.projectId);
  let actor=fresh(providedActor,m.projectId);authorizeCommand(actor,m,recordSource(m.projectId));const signature=hash(canonical(m));const old=db.prepare("SELECT signature FROM receipts WHERE project_id=? AND actor_id=? AND key=?").get(m.projectId,actor.id,m.idempotencyKey) as {signature:string}|undefined;
  if(old){if(old.signature!==signature)throw new ManagementError(409,"IDEMPOTENCY_CONFLICT","此幂等键已用于另一操作");return snapshot(m.projectId,actor);}
  const existingAreas=m.id&&m.type.startsWith("task.")&&m.type!=="task.create"?get(m.projectId,"tasks",id(m.id)).areaIds:m.id&&m.type==="wbs.update"?get(m.projectId,"wbs",id(m.id)).areaIds:undefined;
  const areas=new Map<string,unknown>();for(const key of ids(m.payload.areaIds===undefined?existingAreas:m.payload.areaIds))areas.set(key,await resolveArea(m.projectId,key));
  if(m.type==="issue.create"&&m.payload.riskPointId){allow(actor,"models");const source=await resolveArea(m.projectId,id(m.payload.riskPointId));ensure(source&&typeof source==="object","SPATIAL_NOT_FOUND","风险点不存在");areas.set(String(m.payload.riskPointId),source);}
  if(m.type==="issue.create"){const discoveryKey=discoverySpatialId(m.payload);if(discoveryKey&&!areas.has(discoveryKey))areas.set(discoveryKey,await resolveArea(m.projectId,discoveryKey));}
  let imported:LibraryEvidence|undefined;
  if(m.type==="evidence.register"){if(actor.taskIds!==undefined){const sourceId=String(m.payload.recordId||m.payload.sourceRecordId),slot=String(m.payload.fileKey||"video");ensure(list(m.projectId,"evidence").some(e=>(e.recordId===sourceId||e.sourceRecordId===sourceId)&&e.fileKey===slot&&visible(actor,e,"evidence")),"LIBRARY_REFERENCE_SCOPE","请由授权资料管理员先关联原资料；受限账号不能自行扩展原资料范围");}imported=await resolveLibraryEvidence(m.projectId,id(m.payload.recordId||m.payload.sourceRecordId),id(m.payload.fileKey||"video"));ensure(imported,"LIBRARY_REFERENCE_INVALID","原资料记录或文件尚未核验");if(imported.requiredPermission&&!actor.permissions.includes(imported.requiredPermission))throw new ManagementError(403,"LIBRARY_RESOURCE_FORBIDDEN","当前账号无权引用该原资料资源");}
  let anchorValidated=false;
  if(m.type==="anchor.create"||m.type==="anchor.update"){
   const a=m.payload.anchor as Record<string,unknown>,position=m.payload.position as Record<string,unknown>;ensure(a&&position,"ANCHOR_REQUIRED","缺少模型表面位置");const xyz=a.position as Record<string,unknown>,model=a.model as Record<string,unknown>;
   ensure(a.provenance==="verified-project-photogrammetry-surface"&&xyz?.space==="ecef-meters"&&[xyz.x,xyz.y,xyz.z,position.longitude,position.latitude,position.height].every(v=>typeof v==="number"&&Number.isFinite(v)),"ANCHOR_INVALID","必须是已核验模型表面的有限原始坐标");
   ensure(Number(position.longitude)>=-180&&Number(position.longitude)<=180&&Number(position.latitude)>=-90&&Number(position.latitude)<=90,"ANCHOR_RANGE","经纬度越界");
   const registry=await loadProjectModelRegistry({libraryDataDir:libraryRoot,projectId:m.projectId,modelRegistry:options.modelRegistry});ensure(registry.some(v=>v.projectId===m.projectId&&v.assetId===model?.assetId&&v.assetVersion===model?.assetVersion&&v.coordinateTransformVersion===model?.coordinateTransformVersion),"MODEL_VERSION_CONFLICT","模型或变换版本已经改变，位置草稿保留");
   const lat=Number(position.latitude)*Math.PI/180,lon=Number(position.longitude)*Math.PI/180,h=Number(position.height),n=6378137/Math.sqrt(1-0.0066943799901413165*Math.sin(lat)**2),expected=[(n+h)*Math.cos(lat)*Math.cos(lon),(n+h)*Math.cos(lat)*Math.sin(lon),(n*(1-0.0066943799901413165)+h)*Math.sin(lat)];ensure(Math.hypot(expected[0]-Number(xyz.x),expected[1]-Number(xyz.y),expected[2]-Number(xyz.z))<0.25,"ANCHOR_COORDINATE_MISMATCH","场景坐标与原始模型锚点不一致");anchorValidated=true;
  }
  actor=fresh(providedActor,m.projectId);authorizeCommand(actor,m,recordSource(m.projectId));
  db.exec("BEGIN IMMEDIATE");try{
   const replay=db.prepare("SELECT signature FROM receipts WHERE project_id=? AND actor_id=? AND key=?").get(m.projectId,actor.id,m.idempotencyKey) as {signature:string}|undefined;
   if(replay){if(replay.signature!==signature)throw new ManagementError(409,"IDEMPOTENCY_CONFLICT","此幂等键已用于另一操作");db.exec("COMMIT");return snapshot(m.projectId,actor);}
   let key="",before:number|null=null,after=1,time=now();
   if(m.type==="project.create"){
    allow(actor,"admin");key=id(m.payload.id||randomUUID());ensure(!db.prepare("SELECT id FROM projects WHERE id=?").get(key),"PROJECT_EXISTS","项目编号已存在");const project:ManagementProject={id:key,name:str(m.payload.name,"项目名称",200),revision:1,timezone:"Asia/Shanghai",calendar:{workingDays:[1,2,3,4,5,6]},horizontalCrs:String(m.payload.horizontalCrs||"待核验"),verticalDatum:String(m.payload.verticalDatum||"待核验"),units:"m",isTest:m.payload.isTest===true,createdAt:time,updatedAt:time};db.prepare("INSERT INTO projects VALUES(?,?)").run(key,JSON.stringify(project));
    if(actor.authMode==="local-account"){const source=getMember(m.projectId,actor.id)!;const member={...source,projectId:key,revision:1,roles:["owner"],taskIds:undefined,resourceAccess:{models:true,files:true,media:true},createdAt:time,updatedAt:time};db.prepare("INSERT INTO members VALUES(?,?,?)").run(key,actor.id,JSON.stringify(member));}
   }else if(m.type==="project.update"){
    allow(actor,"admin");const project=getProject(m.projectId);if(m.expectedRevision!==project.revision)throw new ManagementError(409,"REVISION_CONFLICT","项目已变化",undefined,project);before=project.revision;project.revision++;project.updatedAt=time;if(m.payload.name)project.name=str(m.payload.name,"项目名称",200);if(m.payload.horizontalCrs)project.horizontalCrs=str(m.payload.horizontalCrs,"水平坐标系");if(m.payload.verticalDatum)project.verticalDatum=str(m.payload.verticalDatum,"高程基准");if(m.payload.workingDays){ensure(Array.isArray(m.payload.workingDays)&&m.payload.workingDays.length>0&&(m.payload.workingDays as unknown[]).every(v=>Number.isInteger(v)&&Number(v)>=0&&Number(v)<=6),"CALENDAR_INVALID","工作日须为0至6");project.calendar.workingDays=[...new Set(m.payload.workingDays as number[])];}key=project.id;after=project.revision;db.prepare("UPDATE projects SET data=? WHERE id=?").run(JSON.stringify(project),key);
   }else if(m.type==="member.save"){
    allow(actor,"admin");const username=str(m.payload.username,"用户名",80).toLowerCase();ensure(/^[a-z0-9_.@-]+$/.test(username),"USERNAME_INVALID","用户名仅允许英文数字和._@-");const roles=m.payload.roles;ensure(Array.isArray(roles)&&roles.length>0&&roles.every(r=>typeof r==="string"&&Object.hasOwn(rolePermissions,r)),"ROLES_INVALID","角色列表无效");if(!usersExist())ensure(roles.includes("owner"),"INITIAL_OWNER_REQUIRED","首个本机账号须拥有owner角色");
    let user=db.prepare("SELECT id FROM users WHERE username=?").get(username) as {id:string}|undefined;key=user?.id||randomUUID();const oldMember=getMember(m.projectId,key);before=oldMember?.revision||null;if(oldMember&&m.expectedRevision!==oldMember.revision)throw new ManagementError(409,"REVISION_CONFLICT","成员已更新",undefined,oldMember);
    const displayName=str(m.payload.displayName,"成员名称",120);if(user&&m.payload.password&&actor.id!==user.id)throw new ManagementError(403,"CREDENTIAL_OWNER_REQUIRED","不能通过项目成员管理重设其他账号密码；跨项目身份凭据保持独立");if(!user||m.payload.password){const password=str(m.payload.password,"密码",200);ensure(password.length>=10,"WEAK_PASSWORD","本机账号密码至少10个字符");const secret=passwordHash(password);if(user){db.prepare("UPDATE users SET password_hash=?,display_name=? WHERE id=?").run(secret,displayName,key);db.prepare("DELETE FROM sessions WHERE user_id=?").run(key);}else db.prepare("INSERT INTO users VALUES(?,?,?,?,1)").run(key,username,secret,displayName);}else if(actor.id===key)db.prepare("UPDATE users SET display_name=? WHERE id=?").run(displayName,key);
    const access=m.payload.resourceAccess as Record<string,unknown>|undefined;ensure(!access||["models","files","media"].every(k=>access[k]===undefined||typeof access[k]==="boolean"),"RESOURCE_SCOPE_INVALID","资源授权开关须为布尔值");const member:ManagementMember={id:key,projectId:m.projectId,revision:(oldMember?.revision||0)+1,username,displayName,roles:[...new Set(roles)] as ManagementRole[],active:m.payload.active!==false,resourceAccess:{models:access?.models!==false,files:access?.files!==false,media:access?.media!==false},taskIds:m.payload.taskIds===undefined?undefined:ids(m.payload.taskIds),createdAt:oldMember?.createdAt||time,updatedAt:time};
    member.taskIds?.forEach(t=>get(m.projectId,"tasks",t));if(oldMember?.roles.includes("owner")&&(!member.active||!member.roles.includes("owner"))){const owners=(db.prepare("SELECT data FROM members WHERE project_id=?").all(m.projectId) as DbRow[]).map(r=>JSON.parse(r.data) as ManagementMember).filter(v=>v.active&&v.roles.includes("owner"));ensure(owners.length>1,"LAST_OWNER","不能停用最后一个项目所有者");}
    db.prepare("INSERT INTO members VALUES(?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET data=excluded.data").run(m.projectId,key,JSON.stringify(member));after=member.revision;
   }else if(m.type==="evidence.register"){
    ensure(actor.permissions.some(p=>["field","document","inspect","resource"].includes(p)),"EVIDENCE_PERMISSION","当前身份不能登记证据");ensure(imported,"LIBRARY_REFERENCE_INVALID","附件未核验");if(imported.requiredPermission&&!actor.permissions.includes(imported.requiredPermission))throw new ManagementError(403,"LIBRARY_RESOURCE_FORBIDDEN","当前账号无权引用该原资料资源");key=m.id?id(m.id):randomUUID();const e:ManagementRecord={id:key,projectId:m.projectId,revision:1,name:imported.name,status:"ready",createdAt:time,updatedAt:time,createdBy:actor.id,recordId:m.payload.recordId||m.payload.sourceRecordId,fileKey:m.payload.fileKey||"video",url:imported.url,size:imported.size,sha256:imported.sha256,requiredPermission:imported.requiredPermission,sourceModifiedAtMs:imported.modifiedAtMs,mediaSeconds:m.payload.mediaSeconds===undefined?undefined:num(m.payload.mediaSeconds,"媒体秒"),taskId:m.payload.taskId?id(m.payload.taskId):undefined,...fieldObjectReferences({actor,projectId:m.projectId,now:time,get:(kind,key)=>authorizedGet(m.projectId,actor,kind,key)},m.payload.objectRefs)};if(e.taskId)authorizedGet(m.projectId,actor,"tasks",e.taskId);
    if(m.payload.fileId){authorizeEvidence(m.projectId,actor,id(m.payload.fileId));const upload=authorizedGet(m.projectId,actor,"evidence",id(m.payload.fileId));validateEvidence(m.projectId,upload.id);ensure(upload.storageName&&upload.mime==="image/png","CAPTURE_SOURCE_INVALID","取证截图必须是已受控上传的PNG");ensure(m.payload.mediaId===undefined||m.payload.mediaId===`video:${m.payload.sourceRecordId}`,"MEDIA_MISMATCH","取证录像身份不一致");Object.assign(e,{...fieldObjectReferences({actor,projectId:m.projectId,now:time,get:(kind,key)=>authorizedGet(m.projectId,actor,kind,key)},m.payload.objectRefs??upload.objectRefs),name:String(m.payload.name||upload.name),fileId:upload.id,sourceRecordId:m.payload.sourceRecordId,mediaId:`video:${m.payload.sourceRecordId}`,storageName:upload.storageName,size:upload.size,sha256:upload.sha256,mime:upload.mime,url:`${MANAGEMENT_API}/files/${key}/original?projectId=${encodeURIComponent(m.projectId)}`});}
    authorizeRecord(actor,"evidence",e,recordSource(m.projectId),true);storeRecord(m.projectId,"evidence",e);
   }else{
    const payload=structuredClone(m.payload);if(m.type==="issue.create")payload.discovery=validateIssueDiscovery(payload,{actor,projectId:m.projectId,recordId:m.id,get:(kind,key)=>authorizedGet(m.projectId,actor,kind,key),evidence:key=>authorizeEvidence(m.projectId,actor,key),spatial:key=>areas.get(key) as Record<string,unknown>,legacy:key=>readLegacyEvents(legacyEventPath).events.find(e=>e.id===key)});if(m.type.startsWith("anchor."))payload.serverValidated=anchorValidated;if(m.type==="issue.create"){if(payload.riskPointId){allow(actor,"models");const source=areas.get(String(payload.riskPointId)) as Record<string,unknown>;ensure(source.kind==="risk-point"||source.type==="risk-point","RISK_POINT_REQUIRED","必须关联正式用户风险点");payload.positionSnapshot=structuredClone(source);}else ensure(!payload.positionSnapshot,"UNVERIFIED_POSITION","问题位置必须引用服务器核验的用户风险点");}
    const result=applyDomain({actor,projectId:m.projectId,workingDays:getProject(m.projectId).calendar.workingDays,dataVersion:revision(),businessDate:businessDate(m.projectId,time),now:time,command:{...m,payload},list:k=>list(m.projectId,k),get:(k,id)=>authorizedGet(m.projectId,actor,k,id),save:(k,r)=>{const previous=list(m.projectId,k).find(old=>old.id===r.id);if(previous)authorizeRecord(actor,k,previous,recordSource(m.projectId),true);authorizeRecord(actor,k,r,recordSource(m.projectId),true);if(Array.isArray(r.areaIds)&&r.areaIds.every(key=>areas.has(String(key))))r.spatialReferences=r.areaIds.map(key=>(areas.get(String(key)) as {reference:unknown}).reference);storeRecord(m.projectId,k,r);},member:(key,taskIds,permission)=>{if(key!=="local-owner"){const member=getMember(m.projectId,key);ensure(member?.active,"MEMBER_NOT_FOUND","负责人不是有效项目成员");if(taskIds&&member.taskIds!==undefined)ensure(taskIds.every(taskId=>member.taskIds!.includes(taskId)),"ASSIGNEE_TASK_FORBIDDEN","被指派人员未获全部关联任务授权");if(permission)ensure(member.roles.some(role=>rolePermissions[role].includes(permission)),"ASSIGNEE_PERMISSION_REQUIRED","被指派人员没有办理该操作的角色权限");}else ensure(!usersExist(),"LOCAL_ID_UNAVAILABLE","已启用账号，请选择正式成员");},area:key=>ensure(areas.has(key),"SPATIAL_REFERENCE_UNVERIFIED","区域关系未通过服务器核验"),evidence:key=>authorizeEvidence(m.projectId,actor,key),freeze:p=>{
      const D=String(p.D||p.businessAsOf||time.slice(0,10)),F=String(p.F||p.confirmedAsOf||time),filters=(p.filters||{}) as ManagementFilters;const normalizedF=instant(F,"确认截止F");const records=collections(m.projectId,actor,normalizedF),metrics=calculateMetrics(records,{D,F:normalizedF,now:time,revision:revision(),filters});
      const spatialReferences=Object.entries(records).filter(([kind])=>kind!=="reports").flatMap(([,items])=>items.flatMap(r=>[...(Array.isArray(r.spatialReferences)?r.spatialReferences:[]),...((r.positionSnapshot as {reference?:unknown}|undefined)?.reference?[(r.positionSnapshot as {reference:unknown}).reference]:[])]));
      return {spatialReferences:[...new Map(spatialReferences.map(r=>[canonical(r),r])).values()],template:String(p.template||"weekly"),...metrics,filters,sourceRevisions:Object.entries(records).filter(([k])=>k!=="reports").flatMap(([kind,items])=>items.map(r=>({kind,id:r.id,revision:r.revision,data:r}))),dataVersion:revision()};}});
    key=result.record.id;after=result.record.revision;before=after===1?null:after-1;
   }
   bump();audit(m.projectId,actor,m,key,before,after,time);db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(m.projectId,actor.id,m.idempotencyKey,signature,key,time);db.exec("COMMIT");return snapshot(m.projectId,actor);
  }catch(e){db.exec("ROLLBACK");throw publicError(e,actor);}
 }
 function command(m:ManagementCommand,actor:Actor){const run=queue.catch(()=>undefined).then(()=>execute(m,actor));queue=run;return run;}
 const eventBridge=createManagementEventBridge({projectId:legacyProjectId,legacy:()=>readLegacyEvents(legacyEventPath),fresh:actor=>fresh(actor,legacyProjectId),snapshot:actor=>snapshot(legacyProjectId,fresh(actor,legacyProjectId)),command});
 function metrics(projectId:string,actor:Actor,D:string,F=now(),filters:ManagementFilters={}){allow(actor,"read");F=instant(F,"确认截止F");return calculateMetrics(collections(projectId,actor,F),{D,F,now:now(),revision:revision(),filters});}
 function login(username:string,password:string,projectId:string){const row=db.prepare("SELECT id,password_hash,active FROM users WHERE username=?").get(username.toLowerCase()) as {id:string;password_hash:string;active:number}|undefined;if(!row?.active||!passwordMatches(password,row.password_hash))throw new ManagementError(401,"INVALID_CREDENTIALS","用户名或密码不正确");const expiresAt=new Date(Date.parse(now())+SESSION_MS).toISOString(),actor=accountActor(row.id,projectId,expiresAt),token=randomBytes(32).toString("hex");db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(now());db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(hash(token),row.id,expiresAt);return {actor,token};}
 const cookie=(res:ServerResponse,token:string)=>{res.setHeader("Clear-Site-Data",'"cache"');res.setHeader("Set-Cookie",`${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS/1000}`);};
 const failedLogins=new Map<string,{count:number;since:number}>();
 async function accessMiddleware(req:IncomingMessage,res:ServerResponse,next:()=>void){
  try{let path=new URL(req.url||"/","http://localhost").pathname;for(let i=0;i<2;i++){const decoded=decodeURIComponent(path);if(decoded===path)break;path=decoded;}path=path.replaceAll("\\","/");const lower=path.toLowerCase();
   // Filesystem routes are not an alternative object store, even for an owner.
   const rawRoots=["/project-data/","/tmp/","/output/","/.local-backups/","/server/","/.git/"];
   const direct=rawRoots.some(x=>(lower+"/").startsWith(x))||lower.startsWith("/@fs/")&&!['/node_modules/','/src/','/ar_v2/web/'].some(x=>lower.startsWith('/@fs/'+process.cwd().replaceAll('\\','/').toLowerCase()+x));
   if(direct)throw new ManagementError(403,"RAW_STORAGE_FORBIDDEN","请通过受控资料或模型接口访问文件");
   if(!/^\/__(library|local_tiles|models|local_imagery|safety)(?:\/|$)/.test(path)){next();return;}
   sameOrigin(req);const actor=authenticate(req,legacyProjectId);setManagementActor(req,actor);if(path==="/__safety/events"){next();return;}const read=req.method==="GET"||req.method==="HEAD";
   if(actor.taskIds!==undefined){
    const sourceFile=path.match(/^\/__library\/files\/([^/]+)\/([^/]+)\/.+$/);
    if(read&&sourceFile){const referenced=list(legacyProjectId,"evidence").find(e=>e.url===path&&visible(actor,e,"evidence"));if(referenced)authorizeEvidence(legacyProjectId,actor,referenced.id);if(!referenced)throw new ManagementError(403,"FILE_FORBIDDEN","原件或预览未关联当前授权任务");}
    else throw new ManagementError(403,"RESOURCE_SCOPE_FORBIDDEN","完整工程模型与目录需要单独的全项目授权");
   }
   if(path.startsWith("/__local_tiles")||path.startsWith("/__models")||path.startsWith("/__safety/models")||path.startsWith("/__safety/model-optimization"))allow(actor,read?"models":"admin");
   else if(path.startsWith("/__local_imagery"))allow(actor,read?"models":"admin");
   else if(path.startsWith("/__safety"))allow(actor,read?"read":"field");
   else if(path.startsWith("/__library")){
    if(read){const file=path.match(/^\/__library\/files\/([^/]+)\/([^/]+)\//);if(file){const metadata=join(libraryRoot,"records",id(file[1]),"record.json");let kind="";try{kind=JSON.parse(readFileSync(metadata,"utf8")).kind;}catch{/* Unknown files require all grants, never a guessed weaker permission. */}if(["3D Tiles","Model","Imagery"].includes(kind))allow(actor,"models");else if(kind==="Drone Video")allow(actor,"media");else if(["CAD","GIS"].includes(kind))allow(actor,"files");else{allow(actor,"models");allow(actor,"files");allow(actor,"media");}}
     else if(/^\/__library\/records(?:\/[^/]+)?$/.test(path))allow(actor,"read"); // The library filters metadata using the trusted actor.
     else{allow(actor,"read");allow(actor,"files");allow(actor,"models");allow(actor,"media");}}
    else if(path==="/__library/view")allow(actor,"read");else allow(actor,"admin");
   }
   next();
  }catch(e){errorOutput(res,e);}
 }
 async function upload(req:IncomingMessage,res:ServerResponse,projectId:string,actor:Actor,url:URL){
  const category=workflowCategory(url.searchParams.get("workflowCategory")||undefined);
  const authorizeUpload=(current:Actor)=>{allow(current,"files");if(!current.permissions.some(p=>["field","document","inspect","resource"].includes(p))&&!(current.permissions.includes("plan")&&(category==="construction-plan"||category==="supervision-plan")))throw new ManagementError(403,"UPLOAD_FORBIDDEN","当前身份不能上传此类附件");};
  authorizeUpload(actor);
  const name=basename(str(url.searchParams.get("name"),"文件名",250));ensure(!/[\r\n]/.test(name),"FILE_NAME_INVALID","文件名无效");const mime=String(req.headers["content-type"]||"application/octet-stream").split(";")[0];ensure(!['text/html','image/svg+xml','application/javascript'].includes(mime),"ACTIVE_CONTENT_UNSUPPORTED","此入口不接受可执行网页附件");
  validateWorkflowFile(category,{name,mime});
  let objectRefs:unknown;const rawRefs=url.searchParams.get("objectRefs");if(rawRefs!==null){try{objectRefs=JSON.parse(rawRefs);}catch{throw new ManagementError(400,"INVALID_OBJECT_REFS","对象关联JSON无效");}}
  fieldObjectReferences({actor,projectId,now:now(),get:(kind,key)=>authorizedGet(projectId,actor,kind,key)},objectRefs);
  const data=await body(req,100*1024*1024);ensure(data.length>0,"EMPTY_FILE","附件为空");const taskId=url.searchParams.get("taskId")||undefined;if(taskId)authorizedGet(projectId,actor,"tasks",id(taskId));allow(actor,"files");const key=randomUUID(),folder=join(root,"management-files"),destination=join(folder,key),tmp=destination+".pending";mkdirSync(folder,{recursive:true});writeFileSync(tmp,data,{flag:"wx"});renameSync(tmp,destination);
  const task=queue.catch(()=>undefined).then(()=>{db.exec("BEGIN IMMEDIATE");try{const current=fresh(actor,projectId),at=now();authorizeUpload(current);if(taskId)authorizedGet(projectId,current,"tasks",taskId);const record:ManagementRecord={id:key,projectId,revision:1,name,status:"ready",createdAt:at,updatedAt:at,createdBy:current.id,taskId,workflowCategory:category,...fieldObjectReferences({actor:current,projectId,now:at,get:(kind,key)=>authorizedGet(projectId,current,kind,key)},objectRefs),storageName:key,size:data.length,mime,sha256:hash(data),url:`${MANAGEMENT_API}/files/${key}/original?projectId=${encodeURIComponent(projectId)}`};authorizeRecord(current,"evidence",record,recordSource(projectId),true);storeRecord(projectId,"evidence",record);bump();audit(projectId,current,{type:"evidence.register",projectId,idempotencyKey:key,payload:{reason:"受控二进制上传"}},key,null,1,at);db.exec("COMMIT");return record;}catch(e){db.exec("ROLLBACK");try{unlinkSync(destination);}catch{/* original error retained */}throw e;}});queue=task;output(res,201,await task);
 }
 async function middleware(req:IncomingMessage,res:ServerResponse,next:()=>void){
  let url:URL;try{url=new URL(req.url||"/","http://localhost");}catch{next();return;}if(url.pathname==="/__safety/events"){try{sameOrigin(req);const actor=authenticate(req,legacyProjectId);await eventBridge.middleware(req,res,actor);}catch(e){errorOutput(res,e);}return;}if(!url.pathname.startsWith(MANAGEMENT_API+"/")&&url.pathname!==MANAGEMENT_API){next();return;}
  let responseActor:Actor|undefined;
  try{sameOrigin(req);const projectId=url.searchParams.get("projectId")||legacyProjectId;
   if(url.pathname===MANAGEMENT_API+"/positioning/ingest"){
    if(req.method!=="POST")throw new ManagementError(405,"METHOD_NOT_ALLOWED","设备上报仅支持POST");
    // Device auth never falls back to browser cookies or the local-owner compatibility path.
    const device=positioning.authenticate(req.headers.authorization);getProject(device.projectId);
    ensure(req.headers["content-type"]?.startsWith("application/json"),"CONTENT_TYPE","请求必须为JSON");
    let input:unknown;try{input=JSON.parse((await body(req,16_384)).toString("utf8"));}catch(e){if(e instanceof ManagementError)throw e;throw new ManagementError(400,"INVALID_JSON","JSON格式无效");}
    output(res,202,positioning.ingest(device,input,list(device.projectId,"railSafety") as RailSafetyRecord[]));return;
   }
   if(url.pathname===MANAGEMENT_API+"/session"){
    if(req.method==="POST"){
     requestMarker(req);const input=await jsonBody(req);const loginKey=(req.socket.remoteAddress||"")+":"+String(input.username).toLowerCase(),attempt=failedLogins.get(loginKey);if(attempt&&attempt.count>=10&&Date.now()-attempt.since<300000)throw new ManagementError(429,"LOGIN_RATE_LIMIT","登录尝试过多，请稍后重试");
     try{const result=login(str(input.username,"用户名",80),str(input.password,"密码",200),String(input.projectId||projectId));failedLogins.delete(loginKey);cookie(res,result.token);output(res,200,publicSession(result.actor));}catch(e){failedLogins.set(loginKey,{count:attempt&&Date.now()-attempt.since<300000?attempt.count+1:1,since:attempt?.since||Date.now()});throw e;}return;
    }
    if(req.method==="DELETE"){requestMarker(req);const token=req.headers.cookie?.split(";").map(s=>s.trim()).find(v=>v.startsWith(COOKIE+"="))?.slice(COOKIE.length+1);if(token)db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash(token));res.setHeader("Clear-Site-Data",'"cache"');res.setHeader("Set-Cookie",`${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);output(res,200,{ok:true});return;}
    if(req.method==="GET"){output(res,200,publicSession(authenticate(req,projectId)));return;}throw new ManagementError(405,"METHOD_NOT_ALLOWED","身份接口不支持该方法");
   }
   if(req.method==="POST"&&[MANAGEMENT_API+"/commands",MANAGEMENT_API+"/command"].includes(url.pathname)){
    requestMarker(req);const input=await jsonBody(req) as ManagementCommand;const actor=authenticate(req,input.projectId),bootstrap=actor.authMode==="local-owner"&&input.type==="member.save";responseActor=actor;
    const result=await command(input,actor);if(bootstrap){const logged=login(String(input.payload.username),String(input.payload.password),input.projectId);cookie(res,logged.token);result.session=publicSession(logged.actor);}output(res,200,result);return;
   }
   const actor=authenticate(req,projectId);responseActor=actor;
   if(url.pathname===MANAGEMENT_API+"/positioning"){
    if(req.method!=="GET")throw new ManagementError(405,"METHOD_NOT_ALLOWED","定位状态仅支持GET");
    allow(actor,"read");allow(actor,"models");const all=list(projectId,"railSafety") as RailSafetyRecord[];
    output(res,200,positioning.snapshot(projectId,all.filter(record=>visible(actor,record,"railSafety")),all));return;
   }
   if(req.method==="GET"&&[MANAGEMENT_API+"/state",MANAGEMENT_API+"/snapshot"].includes(url.pathname)){output(res,200,snapshot(projectId,actor));return;}
   if(req.method==="GET"&&url.pathname===MANAGEMENT_API+"/metrics"){
    const filters:ManagementFilters={taskIds:url.searchParams.getAll("taskId"),areaIds:url.searchParams.getAll("areaId"),ownerId:url.searchParams.get("ownerId")||undefined,status:url.searchParams.get("status")||undefined,query:url.searchParams.get("query")||undefined,periodStart:url.searchParams.get("periodStart")||undefined,periodEnd:url.searchParams.get("periodEnd")||undefined};output(res,200,metrics(projectId,actor,url.searchParams.get("D")||now().slice(0,10),url.searchParams.get("F")||now(),filters));return;
   }
   if(req.method==="POST"&&[MANAGEMENT_API+"/upload",MANAGEMENT_API+"/uploads"].includes(url.pathname)){requestMarker(req);await upload(req,res,projectId,actor,url);return;}
   const conditionsMatch=url.pathname.match(/^\/__management\/tasks\/([^/]+)\/conditions$/);if(req.method==="GET"&&conditionsMatch){const task=authorizedGet(projectId,actor,"tasks",id(conditionsMatch[1]));output(res,200,evaluateTaskConditions({now:now(),businessDate:businessDate(projectId),list:k=>list(projectId,k),get:(k,key)=>authorizedGet(projectId,actor,k,key),evidence:key=>authorizeEvidence(projectId,actor,key)},task,revision()));return;}
   const recordMatch=url.pathname.match(/^\/__management\/records\/([^/]+)\/([^/]+)$/);if(req.method==="GET"&&recordMatch){const kind=recordMatch[1] as ManagementCollection;ensure(MANAGEMENT_COLLECTIONS.includes(kind),"COLLECTION_INVALID","资料集合不存在");const record=get(projectId,kind,id(recordMatch[2]));if(!visible(actor,record,kind))throw new ManagementError(403,"RECORD_FORBIDDEN","记录不在任务授权范围");output(res,200,publicRecord(kind,record,actor));return;}
   const fileMatch=url.pathname.match(/^\/__management\/files\/([^/]+)\/(original|preview)$/);if((req.method==="GET"||req.method==="HEAD")&&fileMatch){
    allow(actor,"files");const e=get(projectId,"evidence",id(fileMatch[1]));if(!visible(actor,e,"evidence"))throw new ManagementError(403,"FILE_FORBIDDEN","附件不在授权任务范围");validateEvidence(projectId,e.id);ensure(e.storageName,"FILE_EXTERNAL","原资料附件应使用其已授权资料地址");const path=join(root,"management-files",id(e.storageName));const real=realpathSync(path);ensure(real.startsWith(realpathSync(join(root,"management-files"))+sep),"FILE_PATH_INVALID","附件路径无效");
    res.setHeader("Content-Type",String(e.mime||"application/octet-stream"));res.setHeader("Content-Length",String(e.size));res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Content-Security-Policy","sandbox");res.setHeader("Cache-Control","private, no-store");res.setHeader("Vary","Cookie");res.setHeader("Content-Disposition",`inline; filename*=UTF-8''${encodeURIComponent(e.name)}`);if(req.method==="HEAD")res.end();else createReadStream(path).pipe(res);return;
   }
   throw new ManagementError(404,"ENDPOINT_NOT_FOUND","管理接口不存在");
  }catch(e){errorOutput(res,e,responseActor);}
 }
 return {middleware,accessMiddleware,command,load:snapshot,metrics,authenticate,localActor,root,close:()=>{if(!closed){closed=true;db.close();}}};
}
export function managementPlugin(options:ManagementStoreOptions={}):Plugin{
 const attach=(server:{middlewares:{use:(handler:ReturnType<typeof createManagementStore>["middleware"])=>void};httpServer?:{once:(event:string,callback:()=>void)=>void}|null})=>{const store=createManagementStore(options);server.middlewares.use(store.accessMiddleware);server.middlewares.use(store.middleware);server.httpServer?.once("close",()=>store.close());};
 return {name:"cesium-persistent-management",enforce:"pre",configureServer:attach,configurePreviewServer:attach};
}
