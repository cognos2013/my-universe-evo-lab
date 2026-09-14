import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
await mkdir('reports',{recursive:true});
const startedAt=new Date().toISOString();
const commands=[['check',['run','check']],['scenarios',['run','validate']],['build',['run','build']],['browser',['run','test:browser']],['performance',['run','benchmark']],['dynamics',['run','benchmark:gravity']]] as const;
const results=[];
for(const[name,args]of commands){
  console.log(`审核 ${name}…`);
  const started=performance.now();let log='';
  const exitCode=await new Promise<number>(resolve=>{
    const child=spawn(process.platform==='win32'?'npm.cmd':'npm',[...args],{stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',chunk=>{log+=chunk;});child.stderr.on('data',chunk=>{log+=chunk;});
    child.on('error',error=>{log+=String(error);resolve(1);});child.on('close',code=>resolve(code??1));
  });
  const path=`reports/final-${name}.txt`;await writeFile(path,log);results.push({name,exitCode,milliseconds:performance.now()-started,log:path});
  console.log(`${exitCode===0?'PASS':'FAIL'} ${name}`);
  if(exitCode!==0)break;
}
const hash=createHash('sha256');
async function fingerprint(path:string){
  for(const entry of(await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=join(path,entry.name);if(entry.isDirectory())await fingerprint(file);else if(/\.(ts|css)$/.test(file)){hash.update(file);hash.update(await readFile(file));}}
}
for(const dir of ['src','scripts','tests'])await fingerprint(dir);
for(const file of ['package.json','package-lock.json','tsconfig.json','vite.config.ts','playwright.config.ts','index.html']){hash.update(file);hash.update(await readFile(file));}
const passed=results.length===commands.length&&results.every(r=>r.exitCode===0);
await writeFile('reports/final-audit.json',JSON.stringify({startedAt,finishedAt:new Date().toISOString(),passed,sourceSha256:hash.digest('hex'),results,scope:'Local ecological MVP P0–P9 and P10-A/B stellar reservoirs and isolated gravitational assembly; P10-C and P11–P17 remain incomplete; not full cosmology, abiogenesis, civilization or real-Earth forecasting.',reviewNotes:['Automated tests plus implementation review were performed by the primary coding agent; this is not an independent scientific validation.','Browser/GPU total RSS and cross-browser bitwise reproducibility remain unverified.']},null,2));
if(!passed)process.exitCode=1;
