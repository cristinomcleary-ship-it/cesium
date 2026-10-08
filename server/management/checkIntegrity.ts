import { createHash,randomUUID } from "node:crypto";
import type { ManagementCheckItem,ManagementRecord } from "../../src/managementTypes.ts";
import { ensure,id,str } from "./domain.ts";
export function checklistVersion(record:Record<string,unknown>):string{
 const items=(record.items as ManagementCheckItem[]||[]).map(item=>({id:item.id,name:item.name,required:item.required,allowNotApplicable:item.allowNotApplicable===true}));
 return createHash("sha256").update(JSON.stringify({templateVersion:record.templateVersion??1,items})).digest("hex");
}
export function newCheckItems(value:unknown):ManagementCheckItem[]{
 ensure(Array.isArray(value)&&value.length>0,"NO_CHECK_ITEMS","请提供检查项目");const seen=new Set<string>();
 return value.map((raw:Record<string,unknown>)=>{ensure(raw&&typeof raw==="object"&&!Array.isArray(raw),"CHECK_ITEM_INVALID","检查项须为有效记录");const key=id(raw.id||randomUUID());ensure(!seen.has(key),"CHECK_DUPLICATE_ID","检查项编号必须唯一");seen.add(key);ensure(raw.allowNotApplicable===undefined||typeof raw.allowNotApplicable==="boolean","CHECK_APPLICABILITY_INVALID","不适用规则须为布尔值");return {id:key,name:str(raw.name,"检查项",200),required:raw.required!==false,allowNotApplicable:raw.allowNotApplicable===true,result:"pending"};});
}
export function recordCheckItems(record:ManagementRecord,payload:Record<string,unknown>,evidence:(value:unknown)=>string[]):ManagementCheckItem[]{
 const version=checklistVersion(record);ensure(payload.checklistVersion===version,"CHECK_VERSION_MISMATCH","检查清单版本已变化或未提供，请刷新清单；草稿保留",{checklistVersion:version});
 const originals=record.items as ManagementCheckItem[];ensure(Array.isArray(originals)&&new Set(originals.map(x=>x.id)).size===originals.length,"CHECK_STORED_INTEGRITY","历史清单存在重复编号，请新建核实后的清单，原记录保留");
 ensure(Array.isArray(payload.items)&&payload.items.length===originals.length,"CHECK_ITEM_MISMATCH","请逐项填写该版本完整检查清单");const submitted=new Map<string,Record<string,unknown>>();
 for(const raw of payload.items as Record<string,unknown>[]){ensure(raw&&typeof raw==="object"&&!Array.isArray(raw),"CHECK_ITEM_INVALID","检查项须为有效记录");const key=id(raw.id);ensure(!submitted.has(key),"CHECK_DUPLICATE_ID","同一检查项不能重复提交");ensure(originals.some(x=>x.id===key),"CHECK_ITEM_MISMATCH","包含清单以外的检查项");ensure(!["required","name","allowNotApplicable","applicability"].some(field=>field in raw),"CHECK_DEFINITION_IMMUTABLE","检查名称、必检属性和适用规则由原清单决定");submitted.set(key,raw);}
 return originals.map(original=>{const raw=submitted.get(original.id)!;ensure(raw,"CHECK_ITEM_MISMATCH","缺少原清单检查项");ensure(["pass","fail","pending","not-applicable"].includes(String(raw.result)),"INVALID_RESULT","检查结论无效");if(raw.result==="not-applicable"){ensure(original.allowNotApplicable===true,"CHECK_NOT_APPLICABLE_FORBIDDEN","该检查项未配置允许不适用");str(raw.basis,"不适用依据");}return {...original,result:raw.result as ManagementCheckItem["result"],basis:String(raw.basis||""),evidenceIds:evidence(raw.evidenceIds)};});
}
export function confirmCheckIntegrity(record:ManagementRecord,payload:Record<string,unknown>){
 const items=record.items as ManagementCheckItem[];ensure(Array.isArray(items)&&items.length>0&&new Set(items.map(v=>v.id)).size===items.length,"CHECK_STORED_INTEGRITY","检查项不完整，请重新核实清单");
 ensure(payload.checklistVersion===checklistVersion(record),"CHECK_VERSION_MISMATCH","请按当前清单版本签认");ensure(items.every(v=>["pending","pass","fail","not-applicable"].includes(v.result)),"CHECK_STORED_INTEGRITY","历史清单结论无效，须重新核实");ensure(items.every(v=>v.result!=="pending"),"CHECK_INCOMPLETE","仍有待核实检查项");for(const item of items)if(item.result==="not-applicable"){ensure(item.allowNotApplicable===true,"CHECK_NOT_APPLICABLE_FORBIDDEN","该检查项未配置允许不适用");str(item.basis,"不适用依据");}
}
