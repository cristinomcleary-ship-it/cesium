// CPU test runner adapter for Vite's extensionless TS/JSON imports. Production files stay unchanged.
import { registerHooks } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const sourceRoot=pathToFileURL(path.resolve('src')+path.sep).href;
registerHooks({
 resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier,context); }
  catch(error) {
   if(error.code==='ERR_MODULE_NOT_FOUND'&&specifier.startsWith('.')&&context.parentURL?.startsWith(sourceRoot)&&!path.extname(specifier)) {
    for(const extension of ['.ts','.js']) {
     const candidate=new URL(specifier+extension,context.parentURL);
     if(existsSync(fileURLToPath(candidate)))return nextResolve(candidate.href,context);
    }
   }
   throw error;
  }
 },
 load(url,context,nextLoad) {
  if(url.startsWith(sourceRoot)&&url.endsWith('.json'))return {format:'module',shortCircuit:true,source:'export default '+readFileSync(fileURLToPath(url),'utf8')+';'};
  return nextLoad(url,context);
 }
});
