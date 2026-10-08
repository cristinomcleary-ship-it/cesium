import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createManagementStore } from '../server/managementStore.ts';
const run=promisify(execFile),cwd=process.cwd(),tmpRoot=resolve('tmp/management-launcher-cpu');
await mkdir(tmpRoot,{recursive:true});const dir=await mkdtemp(join(tmpRoot,'case-'));
const store=createManagementStore({dataDir:dir});
const server=createServer((req,res)=>void store.middleware(req,res,()=>{res.statusCode=404;res.end();}));
await new Promise(done=>server.listen(0,'127.0.0.1',done));const port=server.address().port;
const checks=[];
async function powershell(args){return await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass',...args],{cwd,timeout:20000,maxBuffer:1024*1024});}
async function launcher(){const {stdout}=await powershell(['-File','tools/start-safety-dashboard.ps1','-Port',String(port),'-NoBrowser']);assert.match(stdout,/Reusing the running Cesium service\./);return stdout;}
try{
 await launcher();checks.push('existing unconfigured management service is reused; no browser or server launched');
 const response=await fetch(`http://127.0.0.1:${port}/__management/commands`,{method:'POST',headers:{'Content-Type':'application/json','X-Cesium-Library':'1'},body:JSON.stringify({projectId:'safety:project',type:'member.save',idempotencyKey:'bootstrap-launcher',payload:{username:'owner',password:'Launcher-test-password',displayName:'Isolated owner',roles:['owner']}})});assert.equal(response.status,200,await response.text());
 await launcher();checks.push('existing account-protected management service is reused on verified AUTH_REQUIRED 401');
 const definitions = String.raw`$tokens=$null; $errors=$null; $ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'tools/start-safety-dashboard.ps1'),[ref]$tokens,[ref]$errors); if($errors.Count){throw $errors[0]}; $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$false) | ForEach-Object { Invoke-Expression $_.Extent.Text }; `;
 const assertions=String.raw`
function Check($name,$actual,$expected){if($actual -ne $expected){throw ($name+': '+$actual)};Write-Output $name}
Check 'reject unrelated JSON response' (Test-DashboardSessionResponse 200 'application/json' '{"ok":true}') $false
Check 'reject HTML response with otherwise matching body' (Test-DashboardSessionResponse 200 'text/html' '{"authMode":"local-owner","userId":"x","roles":[],"permissions":[]}') $false
Check 'reject unrelated 401' (Test-DashboardSessionResponse 401 'application/json' '{"code":"UNAUTHORIZED","error":"denied"}') $false
Check 'reject error code in wrong status' (Test-DashboardSessionResponse 500 'application/json' '{"code":"AUTH_REQUIRED","error":"denied"}') $false
Check 'accept explicit session expiry contract' (Test-DashboardSessionResponse 401 'application/json; charset=utf-8' '{"code":"SESSION_EXPIRED","error":"expired"}') $true
Check 'accept real local account session shape' (Test-DashboardSessionResponse 200 'application/json' '{"authMode":"local-account","userId":"x","roles":["viewer"],"permissions":["read"]}') $true
Check 'reject malformed JSON' (Test-DashboardSessionResponse 401 'application/json' 'broken') $false
$node=Find-DashboardNode
Check 'selected Node runtime exists' (Test-Path -LiteralPath $node -PathType Leaf) $true
Write-Output ('NODE_RUNTIME='+$node)
`;
 const {stdout}=await powershell(['-Command',definitions+assertions]);
 checks.push(...stdout.trim().split(/\r?\n/).filter(line=>!line.startsWith('NODE_RUNTIME=')));
 const report={checkedAt:new Date().toISOString(),scope:'Windows PowerShell original-launcher CPU and isolated real HTTP; no browser/GPU or formal data writes',checks,pass:checks.length,fail:0,nodeRuntime:stdout.match(/NODE_RUNTIME=(.+)/)?.[1]?.trim(),scriptSha256:createHash('sha256').update(await readFile('tools/start-safety-dashboard.ps1')).digest('hex')};
 await mkdir('output/platform-management',{recursive:true});await writeFile('output/platform-management/launcher-regression.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{
 await new Promise(done=>server.close(done));store.close();
 assert.ok(resolve(dir).startsWith(tmpRoot+sep));await rm(dir,{recursive:true,force:true});
}
