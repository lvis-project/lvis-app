import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

if (process.platform !== "win32") throw new Error("This test requires Windows");
const helper = resolve(`resources/windows-job/${process.arch}/lvis-job.exe`);
const failureHelper = resolve(`resources/windows-job/${process.arch}/lvis-job-failure.exe`);
const directory = mkdtempSync(join(tmpdir(), "lvis job test "));
const fixture = join(directory, "child fixture.cjs");
writeFileSync(fixture, `const {spawn}=require('node:child_process');
if(process.argv[2]==='leaf'){console.log(process.pid);setInterval(()=>{},1000)}
else {const child=spawn(process.execPath,[__filename,'leaf'],{stdio:['ignore','pipe','inherit']});
child.stdout.once('data',data=>{process.stdout.write(data); if(process.argv[2]==='root-exit') process.exit(23)});
setInterval(()=>{},1000)}`);
function launch(exe, args, binary = helper) {
  const child = spawn(binary, [exe, ...args], { cwd: directory, stdio: ['pipe','pipe','pipe'], windowsHide:true });
  track(child);
  let stdout='', stderr='';
  child.stdout.on('data', data=>{stdout+=data}); child.stderr.on('data',data=>{stderr+=data});
  const done = once(child,'close').then(([code])=>({code,stdout,stderr}));
  child.on('error',()=>{});
  return {child,done};
}
async function deadline(promise) {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timed out')),10000)})]); }
  finally {clearTimeout(timer)}
}
async function gone(pid) {
  for(let i=0;i<100;i++) {
    try { process.kill(pid,0) } catch(error) { if(error.code==='ESRCH')return; throw error }
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw new Error(`Owned descendant ${pid} survived`);
}
const active=[];
function track(child) {
  active.push({ child, closed: new Promise(resolve => child.once('close', resolve)) });
}
try {
  const buildRoot = join(directory, '검증 %TEST% path');
  mkdirSync(join(buildRoot, 'scripts'), { recursive: true });
  mkdirSync(join(buildRoot, 'native/windows-job'), { recursive: true });
  const buildScript = join(buildRoot, 'scripts/build-windows-job.ps1');
  copyFileSync(new URL('./build-windows-job.ps1', import.meta.url), buildScript);
  copyFileSync(new URL('../native/windows-job/launcher.cpp', import.meta.url), join(buildRoot, 'native/windows-job/launcher.cpp'));
  const build = () => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', buildScript, '-Arch', process.arch], {
    env: { ...process.env, TEST: 'must-not-expand' }, encoding: 'utf8',
  });
  const pathHelper = join(buildRoot, `resources/windows-job/${process.arch}/lvis-job.exe`);
  build();
  const firstHash = createHash('sha256').update(readFileSync(pathHelper)).digest('hex');
  build();
  assert.equal(createHash('sha256').update(readFileSync(pathHelper)).digest('hex'), firstHash);
  const pathRun = await deadline(launch(process.execPath, ['-e', 'process.stdout.write("literal-path-ok");process.exit(19)'], pathHelper).done);
  assert.equal(pathRun.code, 19); assert.equal(pathRun.stdout, 'literal-path-ok');
  console.log('PASS reproducible native build and execution from Unicode, spaces, and literal percent path');
  const spacedHelper=join(directory,'launcher with spaces.exe');
  copyFileSync(helper,spacedHelper);
  const spaced=await deadline(launch(process.execPath,['-e','process.stdout.write("ok")'],spacedHelper).done);
  assert.equal(spaced.code,0);assert.equal(spaced.stdout,'ok');
  console.log('PASS helper executable path with spaces');
  const args=['hello world','a"b','C:\\space path\\','', '한국어'];
  let run=launch(process.execPath,['-e','process.stdout.write(JSON.stringify(process.argv.slice(1)));process.stderr.write("err");process.exit(17)',...args]);
  let result=await deadline(run.done);
  assert.equal(result.code,17);assert.deepEqual(JSON.parse(result.stdout),args);assert.equal(result.stderr,'err');
  console.log('PASS stdout/stderr, exit code, spaces, quotes, backslashes, empty and Unicode arguments');
  run=launch(process.execPath,['-e','process.stdin.on("data",()=>process.exit(9));process.stdin.on("end",()=>process.exit(0));process.stdin.resume()']);
  assert.equal((await deadline(run.done)).code,0);
  console.log('PASS command stdin is NUL');
  const bash = 'C:/Program Files/Git/bin/bash.exe';
  assert.ok(existsSync(bash), 'Native test requires the configured Bash executable');
  run=launch(bash,['-c', `printf '%s\\n' 'space value' 'quote"value' 'C:\\trailing\\'`]);
  result=await deadline(run.done);assert.equal(result.code,0);assert.equal(result.stdout,'space value\nquote"value\nC:\\trailing\\\n');
  console.log('PASS actual Bash command quoting');
  for(const mode of ['root-exit','kill-helper','owner-eof']) {
    run=launch(process.execPath,[fixture,mode]);
    const [output]=await deadline(once(run.child.stdout,'data'));
    const pid=Number(output.toString().trim());assert.ok(pid>0);
    if(mode==='kill-helper')run.child.kill();
    if(mode==='owner-eof')run.child.stdin.end();
    result=await deadline(run.done);await gone(pid);
    if(mode==='root-exit')assert.equal(result.code,23);
    if(mode==='owner-eof')assert.equal(result.code,130);
    console.log(`PASS ${mode} terminates descendant`);
  }
  const owner=join(directory,'owner.cjs');
  writeFileSync(owner,`const{spawn}=require('node:child_process');const c=spawn(${JSON.stringify(helper)},[process.execPath,${JSON.stringify(fixture)},'wait'],{stdio:['pipe','pipe','inherit']});c.stdout.once('data',d=>{process.stdout.write(d);process.exit(0)})`);
  const parent=spawn(process.execPath,[owner],{stdio:['ignore','pipe','pipe']});
  track(parent);
  const [output]=await deadline(once(parent.stdout,'data'));await deadline(once(parent,'close'));await gone(Number(output.toString().trim()));
  console.log('PASS actual owner process exit terminates descendant');
  writeFileSync(owner,`const{spawn}=require('node:child_process');const c=spawn(${JSON.stringify(helper)},[process.execPath,${JSON.stringify(fixture)},'wait'],{stdio:['pipe','pipe','inherit']});c.stdout.once('data',d=>process.stdout.write(d));setInterval(()=>{},1000)`);
  const killedOwner=spawn(process.execPath,[owner],{stdio:['ignore','pipe','pipe']});
  track(killedOwner);
  const killedOwnerDone=once(killedOwner,'close');
  const [killedOutput]=await deadline(once(killedOwner.stdout,'data'));
  killedOwner.kill();await deadline(killedOwnerDone);await gone(Number(killedOutput.toString().trim()));
  console.log('PASS forced owner termination closes lifetime pipe and kills descendant');
  assert.ok(existsSync(failureHelper),'Build -FailureFixture before running this suite');
  const marker=join(directory,'must-not-exist');
  run=launch(process.execPath,['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`],failureHelper);
  result=await deadline(run.done);assert.equal(result.code,125);assert.equal(existsSync(marker),false);assert.match(result.stderr,/failed/);
  console.log('PASS job assignment failure never runs command');
  const elapsed=[];
  for(let i=0;i<15;i++){const start=performance.now();await deadline(launch(process.execPath,['-e','']).done);elapsed.push(performance.now()-start)}
  const direct=[];
  for(let i=0;i<15;i++){const start=performance.now();await once(spawn(process.execPath,['-e',''],{stdio:'ignore'}),'close');direct.push(performance.now()-start)}
  run=launch(process.execPath,['-e','setInterval(()=>{},1000)']);
  const rss=execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${run.child.pid}).WorkingSet64`],{encoding:'utf8'}).trim();
  run.child.stdin.end();await deadline(run.done);
  const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
  console.log(JSON.stringify({helperMedianMs:median(elapsed),directMedianMs:median(direct),helperWorkingSetBytes:Number(rss)}));
} finally {
  await Promise.all(active.map(async ({ child, closed }) => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }));
  rmSync(directory,{recursive:true,force:true});
}
