import { existsSync,readFileSync,realpathSync,statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join,relative,isAbsolute } from "node:path";
import type { ManagementRecord } from "../../src/managementTypes.ts";
import { ensure,id } from "./domain.ts";
const inside=(root:string,file:string)=>{const part=relative(root,file);return !!part&&part!==".."&&!part.startsWith("..\\")&&!part.startsWith("../")&&!isAbsolute(part);};
/** Synchronous checks run inside the same transaction as the consuming command. */
export function validateEvidenceStorage(record:ManagementRecord,root:string,libraryRoot:string,customResolver=false){
 ensure(record.status==="ready","EVIDENCE_UNAVAILABLE","附件上传未完成或已失效");
 if(record.storageName){const directory=join(root,"management-files"),file=join(directory,id(record.storageName));ensure(existsSync(file),"EVIDENCE_MISSING","附件文件已缺失");const actual=realpathSync(file);ensure(inside(realpathSync(directory),actual),"EVIDENCE_PATH_INVALID","附件位置不属于受控存储");ensure(statSync(actual).isFile()&&statSync(actual).size===record.size,"EVIDENCE_MISSING","附件文件缺失或大小已变化");if(record.sha256)ensure(createHash("sha256").update(readFileSync(actual)).digest("hex")===record.sha256,"EVIDENCE_CHANGED","附件内容已变化，不能引用旧证据");return;}
 ensure(typeof record.url==="string"&&record.url.startsWith("/__library/files/"),"EVIDENCE_SOURCE","附件来源无效");
 // An explicitly injected resolver is a trusted external adapter used by isolated CPU fixtures.
 if(customResolver)return;
 try{const parsed=record.url.match(/^\/__library\/files\/([^/]+)\/([^/]+)\/(.+)$/);ensure(parsed,"EVIDENCE_SOURCE","原资料地址无效");const [,recordId,slot,encoded]=parsed;id(recordId);id(slot);const file=decodeURIComponent(encoded);ensure(!/[\\\0:]/.test(file)&&file.split("/").every(p=>p&&p!=="."&&p!==".."),"EVIDENCE_PATH_INVALID","原资料路径无效");ensure(!existsSync(join(libraryRoot,"deleted",recordId+".json")),"EVIDENCE_UNAVAILABLE","原资料已停用");const recordRoot=realpathSync(join(libraryRoot,"records",recordId));ensure(inside(realpathSync(libraryRoot),recordRoot),"EVIDENCE_PATH_INVALID","原资料目录越界");const metadata=JSON.parse(readFileSync(join(recordRoot,"record.json"),"utf8"));ensure(metadata.id===recordId&&metadata.files?.[slot]?.url===record.url,"EVIDENCE_SOURCE_CHANGED","原资料槽位或地址已变化");const slotRoot=realpathSync(join(recordRoot,slot)),target=realpathSync(join(slotRoot,file));ensure(inside(recordRoot,slotRoot)&&inside(slotRoot,target),"EVIDENCE_PATH_INVALID","原资料文件越界");const stat=statSync(target);ensure(stat.isFile()&&stat.size===record.size,"EVIDENCE_MISSING","原资料缺失或大小已变化");if(typeof record.sourceModifiedAtMs==="number")ensure(stat.mtimeMs===record.sourceModifiedAtMs,"EVIDENCE_CHANGED","原资料已被替换，请重新核验来源");}catch(error){if(error&&typeof error==="object"&&"code" in error&&typeof error.code==="string"&&["ENOENT","ENOTDIR"].includes(error.code))ensure(false,"EVIDENCE_MISSING","原资料文件已缺失");throw error;}
}
