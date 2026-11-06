#!/usr/bin/env python3
"""Verify the exact source and install archive; keep all output outside source."""
from pathlib import Path, PurePosixPath
import argparse, subprocess, shutil, hashlib, tempfile, tarfile, json, os, re, gzip, base64

ROOT=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser()
parser.add_argument('--output',default=os.environ.get('LAUREL_RELEASE_OUTPUT'))
args=parser.parse_args()
OUT=Path(args.output).expanduser().resolve() if args.output else Path(tempfile.mkdtemp(prefix='laurel-release-'))
if OUT==ROOT or ROOT in OUT.parents:raise SystemExit('Release output must be outside the source repository')
OUT.mkdir(parents=True,exist_ok=True)
GUARD=ROOT/'.github/privacy-guard/privacy-guard.mjs'
GITLEAKS=os.environ.get('GITLEAKS_BIN') or shutil.which('gitleaks')
if not GITLEAKS:
    user_bin=Path.home()/'.local/bin/gitleaks'
    if user_bin.is_file():GITLEAKS=str(user_bin)
if not GITLEAKS:raise SystemExit('Gitleaks is required; no release was approved')
def execute(name,argv,cwd=ROOT):
    p=subprocess.run([str(a) for a in argv],cwd=cwd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    (OUT/(name+'.log')).write_bytes(p.stdout)
    if p.returncode:raise SystemExit(f'{name} failed (exit {p.returncode}); private log: {OUT/(name+".log")}')
    return p.stdout.decode()
def git(*argv):return subprocess.check_output(['git','-C',str(ROOT),*argv])
def digest(data):return hashlib.sha256(data).hexdigest()
def forbidden(name):
    parts=PurePosixPath(name).parts
    banned={'.git','node_modules','evidence','private-assets','private-materials','private-local','dsh-deep-research','.session-scratch','.local','AGENTS.local.md','CLAUDE.local.md','.privacy-guard.rules.json','.privacy-guard-baseline.json','.gitleaksignore'}
    return bool(set(parts)&banned) or any(p.startswith('.env') and p!='.env.example' for p in parts)
staged=git('ls-files','--stage','-z').decode().split('\0')
for row in filter(None,staged):
    mode,oid,stage_file=row.split(' ',2);stage,name=stage_file.split('\t',1)
    if mode in ('120000','160000') or stage!='0':raise SystemExit('Tracked link/submodule/conflict blocks release: '+name)
names=sorted(set(filter(None,git('ls-files','-c','-o','--exclude-standard','-z').decode().split('\0'))))
for name in names:
    if forbidden(name):raise SystemExit('Private/unsupported member blocks release: '+name)
    if not (ROOT/name).is_file() or (ROOT/name).is_symlink():raise SystemExit('Missing or linked member: '+name)
source_hashes={name:digest((ROOT/name).read_bytes()) for name in names}
execute('guard-source',['node',GUARD,'scan','--strict','--no-baseline','--json','--repo',ROOT])
execute('guard-history',['node',GUARD,'history','--strict','--no-baseline','--json','--repo',ROOT])
execute('build-check',['pnpm','run','build:client:check'])
execute('unit',['pnpm','test'])
source_dir=OUT/'source'
if source_dir.exists():raise SystemExit('Use a fresh output directory; source output already exists')
source_dir.mkdir()
for name in names:
    target=source_dir/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/name,target)
gitleaks_common=['--redact=100','--max-target-megabytes','16','--max-decode-depth','3','--no-banner','--config',ROOT/'.gitleaks.toml','--report-format','json']
execute('gitleaks-source',[GITLEAKS,'dir',source_dir,*gitleaks_common,'--report-path',OUT/'gitleaks-source.json'])
execute('gitleaks-history',[GITLEAKS,'git',ROOT,'--log-opts=--all',*gitleaks_common,'--report-path',OUT/'gitleaks-history.json'])
execute('pack',['pnpm','pack','--pack-destination',OUT,'--skip-manifest-obfuscation','--json'])
pkg=json.loads((ROOT/'package.json').read_text())
archive=OUT/(pkg['name'].replace('/','-').lstrip('@')+'-'+pkg['version']+'.tgz')
if not archive.is_file():raise SystemExit('Expected packed artifact not found')
unpacked=OUT/'unpacked';unpacked.mkdir()
members={}
normalizations=[]
with tarfile.open(archive) as tar:
    seen=set()
    for m in tar.getmembers():
        p=PurePosixPath(m.name)
        if p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0]!='package' or '\\' in m.name:raise SystemExit('Unsafe archive path')
        if m.isdir():continue
        if not m.isfile() or m.name in seen:raise SystemExit('Linked or duplicate archive member')
        seen.add(m.name);name='/'.join(p.parts[1:])
        if forbidden(name):raise SystemExit('Private member in install archive: '+name)
        if name not in source_hashes:raise SystemExit('Unreviewed install archive member: '+name)
        data=tar.extractfile(m).read()
        if digest(data)!=source_hashes[name]:
            # pnpm serializes the root manifest. Every field must remain identical.
            if name!='package.json' or json.loads(data)!=json.loads((ROOT/name).read_bytes()):
                raise SystemExit('Install/source content mismatch: '+name)
            normalizations.append({'file':name,'kind':'JSON formatting only','sourceSha256':source_hashes[name],'packageSha256':digest(data)})
        target=unpacked/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
        members[name]=digest(data)
execute('guard-artifact',['node',GUARD,'scan','--strict','--no-baseline','--directory','--json','--repo',unpacked,'--exceptions',ROOT/'.privacy-exceptions.json'])
execute('gitleaks-artifact',[GITLEAKS,'dir',unpacked,*gitleaks_common,'--report-path',OUT/'gitleaks-artifact.json'])
execute('packaged-import',['node','--input-type=module','-e',"import {pathToFileURL} from 'node:url'; const m=await import(pathToFileURL(process.argv[1])); if(typeof m.apply!=='function')process.exit(1);",unpacked/'lib/index.js'])
if any(name.startswith('packages/') for name in members):raise SystemExit('Standard Center must not embed modules')
if len(re.findall(r'^window\.__ModuleLoader__\.load\(', (unpacked/'lib/client.js').read_text(),re.M))!=1:raise SystemExit('Standard Center embeds module factories')
module_out=OUT/'module-release'
execute('module-release',['node','scripts/build-module-release.mjs','--output',module_out])
catalog=json.loads((module_out/'release-catalog.json').read_text())
if digest((module_out/archive.name).read_bytes())!=digest(archive.read_bytes()):raise SystemExit('Repeated Center pack is not reproducible')
module_unpacked=OUT/'unpacked-modules';module_unpacked.mkdir()
extra_artifacts={}
for row in catalog['modules']:
    release=row['releases'][0];file=module_out/(row['id']+'-'+release['version']+'.lmod');raw=file.read_bytes()
    if digest(raw)!=release['sha256'] or len(raw)!=release['bytes']:raise SystemExit('Module release checksum mismatch')
    data=json.loads(gzip.decompress(raw))
    if data['id']!=row['id'] or data['version']!=release['version']:raise SystemExit('Module release identity mismatch')
    seen=set()
    for f in data['files']:
        p=PurePosixPath(f['path']);name=p.as_posix()
        if p.is_absolute() or '..' in p.parts or '\\' in name or not name.startswith('packages/'+row['dir']+'/') or name.lower() in seen or forbidden(name):raise SystemExit('Unsafe module member')
        seen.add(name.lower());payload=base64.b64decode(f['data'],validate=True)
        if name not in source_hashes:raise SystemExit('Unreviewed module member: '+name)
        expected=(ROOT/name).read_bytes()
        if p.name=='package.json':
            clean=json.loads(expected)
            for key in ['scripts','devDependencies','workspaces']:clean.pop(key,None)
            if json.loads(payload)!=clean:raise SystemExit('Unexpected module manifest mutation: '+name)
        elif digest(payload)!=digest(expected):raise SystemExit('Module/source mismatch: '+name)
        target=module_unpacked/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(payload)
    extra_artifacts['module-release/'+file.name]=digest(raw)
execute('guard-modules',['node',GUARD,'scan','--strict','--no-baseline','--directory','--json','--repo',module_unpacked,'--exceptions',ROOT/'.privacy-exceptions.json'])
execute('gitleaks-modules',[GITLEAKS,'dir',module_unpacked,*gitleaks_common,'--report-path',OUT/'gitleaks-modules.json'])
migration_archive=module_out/'migration'/('laurel-center-migration-'+pkg['version']+'.tgz');migration_unpacked=OUT/'unpacked-migration';migration_unpacked.mkdir()
with tarfile.open(migration_archive) as tar:
    seen=set()
    for m in tar.getmembers():
        p=PurePosixPath(m.name)
        if m.isdir():continue
        if not m.isfile() or p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0]!='package' or '\\' in m.name or m.name.lower() in seen:raise SystemExit('Unsafe migration member')
        seen.add(m.name.lower());name='/'.join(p.parts[1:]);payload=tar.extractfile(m).read()
        if forbidden(name):raise SystemExit('Private migration member')
        if name.startswith('packages/'):
            target=module_unpacked/name
            if not target.is_file() or digest(payload)!=digest(target.read_bytes()):raise SystemExit('Migration/module mismatch: '+name)
        elif name=='package.json':
            expected={**pkg,'files':[*pkg['files'],'packages'],'scripts':{}}
            if json.loads(payload)!=expected:raise SystemExit('Unexpected migration root manifest')
        elif name not in members or digest(payload)!=members[name]:raise SystemExit('Migration/Center mismatch: '+name)
        target=migration_unpacked/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(payload)
execute('guard-migration',['node',GUARD,'scan','--strict','--no-baseline','--directory','--json','--repo',migration_unpacked,'--exceptions',ROOT/'.privacy-exceptions.json'])
execute('gitleaks-migration',[GITLEAKS,'dir',migration_unpacked,*gitleaks_common,'--report-path',OUT/'gitleaks-migration.json'])
extra_artifacts['module-release/migration/'+migration_archive.name]=digest(migration_archive.read_bytes())
extra_artifacts['module-release/release-catalog.json']=digest((module_out/'release-catalog.json').read_bytes())
source_archive=OUT/(pkg['name']+'-'+pkg['version']+'-source.tar.gz')
with tarfile.open(source_archive,'w:gz') as tar:
    for name in names:tar.add(source_dir/name,arcname='source/'+name,recursive=False)
after={name:digest((ROOT/name).read_bytes()) for name in names}
if after!=source_hashes:raise SystemExit('Source changed during release verification')
manifest={'version':pkg['version'],'head':git('rev-parse','HEAD').decode().strip(),'gitTree':git('write-tree').decode().strip(),'sourceFiles':len(source_hashes),'packageFiles':len(members),'sourceHashes':source_hashes,'packageHashes':members,'packNormalizations':normalizations,'artifacts':{archive.name:digest(archive.read_bytes()),source_archive.name:digest(source_archive.read_bytes()),**extra_artifacts},'checks':['source-and-history-guard','build-consistency','unit','gitleaks-source-history-artifact-modules-migration','archive-members-and-content','packaged-entry-import','slim-center-single-factory','independent-module-and-migration-content','reproducible-center-pack'],'limits':['No guarantee for images, arbitrary encodings or unknown privacy formats','Desktop GUI acceptance remains manual; exact-runtime and browser workflows are recorded separately','Existing published history is retained, not withdrawn'],'published':False}
(OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'status':'passed','version':pkg['version'],'sourceFiles':len(source_hashes),'packageFiles':len(members),'privateOutput':str(OUT),'artifacts':manifest['artifacts']},ensure_ascii=False))
