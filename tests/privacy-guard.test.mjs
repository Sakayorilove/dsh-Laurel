import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { qaOutput } from '../scripts/private-output.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, symlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const guard = fileURLToPath(new URL('../.github/privacy-guard/privacy-guard.mjs', import.meta.url))
function fixture(fn) {
  const root=mkdtempSync(join(tmpdir(),'laurel-privacy-')),repo=join(root,'repo'),home=join(root,'rules')
  mkdirSync(repo);mkdirSync(home)
  const env={...process.env,PRIVACY_GUARD_HOME:home}
  const git=(...args)=>spawnSync('git',args,{cwd:repo,env,encoding:'utf8'})
  assert.equal(git('init','-q','-b','main').status,0)
  git('config','user.name','Test');git('config','user.email','test@example.com')
  const run=(...args)=>spawnSync(process.execPath,[guard,...args,'--repo',repo],{cwd:repo,env,encoding:'utf8'})
  try { fn({root,repo,env,git,run}) } finally { rmSync(root,{recursive:true,force:true}) }
}
const token=()=>['sk','abcdefghijklmnopqrstuvwxyz0123456789'].join('-')
test('large bundle is scanned; a lower explicit limit fails closed',()=>fixture(({repo,run})=>{
  writeFileSync(join(repo,'bundle.js'),' '.repeat(2_600_000)+'\n'+token())
  let r=run('scan','--strict','--json');assert.equal(r.status,1)
  assert.equal(JSON.parse(r.stdout).meta.files,1)
  assert.ok(!r.stdout.includes(token()))
  r=run('scan','--json','--max-bytes','2097152');assert.equal(r.status,2)
  assert.equal(JSON.parse(r.stdout).meta.skipDetails[0].reason,'too-large')
}))
test('directory symlink target and staged symlink blob are checked',()=>fixture(({repo,git,run})=>{
  symlinkSync('/home/'+'private-canary/deps',join(repo,'node_modules'))
  let r=run('scan','--json');assert.equal(r.status,1)
  assert.equal(JSON.parse(r.stdout).findings[0].rule,'unix-home-path')
  git('add','node_modules');r=run('scan','--staged','--json');assert.equal(r.status,1)
}))
test('URL credentials, query tokens and Windows slash paths are blocked',()=>fixture(({repo,run})=>{
  const samples=[['https://account:', 'SyntheticPassword123@api.example.com'].join(''),['https://api.invalid/?token=','SyntheticToken123456'].join(''),['C:/Users/','private-canary/data'].join('')]
  for(let i=0;i<samples.length;i++)writeFileSync(join(repo,`${i}.txt`),samples[i])
  const r=run('scan','--json');assert.equal(r.status,1)
  const ids=new Set(JSON.parse(r.stdout).findings.map(f=>f.rule))
  for(const id of ['url-credentials','url-query-secret','win-user-path'])assert.ok(ids.has(id),id)
  for(const s of samples)assert.ok(!r.stdout.includes(s))
}))
test('staged scan uses the index, and real hooks block commits then accept clean content',()=>fixture(({repo,git,run})=>{
  assert.equal(run('install-hooks').status,0)
  assert.ok(statSync(join(repo,'.git/hooks/pre-commit')).mode & 0o111)
  writeFileSync(join(repo,'value.txt'),token());git('add','value.txt')
  writeFileSync(join(repo,'value.txt'),'safe')
  assert.equal(run('scan','--staged','--json').status,1)
  assert.notEqual(git('commit','-qm','blocked').status,0)
  git('add','value.txt');assert.equal(git('commit','-qm','clean').status,0)
}))
test('custom hooksPath preserves and executes the existing hook',()=>fixture(({repo,git,run})=>{
  git('config','core.hooksPath','.local-hooks');mkdirSync(join(repo,'.local-hooks'))
  writeFileSync(join(repo,'.local-hooks/pre-commit'),'#!/bin/sh\nprintf preserved > hook-result\n',{mode:0o755})
  assert.equal(run('install-hooks').status,0)
  assert.equal(run('install-hooks').status,0)
  writeFileSync(join(repo,'clean.txt'),'clean');git('add','clean.txt')
  assert.equal(git('commit','-qm','existing-hook').status,0)
  assert.equal(readFileSync(join(repo,'hook-result'),'utf8'),'preserved')
}))
test('linked worktree installs executable hooks in its actual Git directory',()=>fixture(({root,repo,git,env})=>{
  writeFileSync(join(repo,'clean.txt'),'clean');git('add','.');git('commit','-qm','base')
  const worktree=join(root,'worktree');assert.equal(git('worktree','add','-qb','probe',worktree).status,0)
  const run=spawnSync(process.execPath,[guard,'install-hooks','--repo',worktree],{cwd:worktree,env,encoding:'utf8'})
  assert.equal(run.status,0,run.stderr)
  writeFileSync(join(worktree,'leak.txt'),token())
  spawnSync('git',['add','.'],{cwd:worktree,env})
  assert.notEqual(spawnSync('git',['commit','-qm','blocked'],{cwd:worktree,env,encoding:'utf8'}).status,0)
}))
test('pre-push checks reachable history, including secrets removed from worktree',()=>fixture(({root,repo,git,run})=>{
  writeFileSync(join(repo,'secret.txt'),token());git('add','.');assert.equal(git('commit','-qm','unsafe-old-history').status,0)
  rmSync(join(repo,'secret.txt'));git('add','-A');git('commit','-qm','removed')
  assert.equal(run('scan','--json').status,0)
  assert.equal(run('history','--json').status,1)
  run('install-hooks');const remote=join(root,'remote.git');git('init','-q','--bare',remote)
  const result=git('push',remote,'HEAD:refs/heads/main');assert.notEqual(result.status,0)
}))
test('strict mode ignores broad baseline/allow rules and exact exceptions stay file scoped',()=>fixture(({repo,run})=>{
  writeFileSync(join(repo,'a.txt'),token())
  writeFileSync(join(repo,'.privacy-allow'),'.*\n')
  writeFileSync(join(repo,'.privacy-guard-baseline.json'),JSON.stringify({entries:[{rule:'generic-api-key',file:'a.txt',ordinal:1}]}))
  assert.equal(run('scan','--strict','--json').status,1)
}))

test('exact exceptions only suppress the reviewed value in its reviewed file',()=>fixture(({repo,run})=>{
  writeFileSync(join(repo,'a.txt'),token())
  const entry={file:'a.txt',rule:'generic-api-key',sha256:createHash('sha256').update(token()).digest('hex'),reason:'Synthetic test value'}
  writeFileSync(join(repo,'.privacy-exceptions.json'),JSON.stringify({entries:[entry]}))
  assert.equal(run('scan','--strict','--json').status,0)
  writeFileSync(join(repo,'b.txt'),token())
  assert.equal(run('scan','--strict','--json').status,1)
}))
test('a NUL byte cannot hide a secret in a text bundle',()=>fixture(({repo,run})=>{
  writeFileSync(join(repo,'bundle.js'),'\0'+token())
  const result=run('scan','--json');assert.equal(result.status,2)
  assert.equal(JSON.parse(result.stdout).meta.complete,false)
}))
test('QA outputs reject repository and symlink aliases, and accept external storage',()=>fixture(({root,repo})=>{
  const before=process.env.LAUREL_QA_OUTPUT
  const actualRoot=fileURLToPath(new URL('../',import.meta.url))
  try {
    process.env.LAUREL_QA_OUTPUT=actualRoot;assert.throws(()=>qaOutput('probe'),/outside/)
    const alias=join(root,'alias');symlinkSync(actualRoot,alias)
    process.env.LAUREL_QA_OUTPUT=alias;assert.throws(()=>qaOutput('probe'),/outside/)
    process.env.LAUREL_QA_OUTPUT=repo;assert.ok(qaOutput('probe').startsWith(repo))
  } finally {if(before===undefined)delete process.env.LAUREL_QA_OUTPUT;else process.env.LAUREL_QA_OUTPUT=before}
}))
