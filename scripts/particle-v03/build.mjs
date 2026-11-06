import {readFile,writeFile,readdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {qaOutput} from '../private-output.mjs';
const root=new URL('../../',import.meta.url),base=new URL('lib/client/particle-v03/',root);
const read=p=>readFile(new URL(p,base));
const icons={};for(const name of await readdir(new URL('assets/',base))){if(name.endsWith('.svg'))icons[name.slice(0,-4)]=(await read('assets/'+name)).toString().replace('<svg ','<svg class="icon" aria-hidden="true" focusable="false" ')}
const {sceneModels}=await import('../../lib/client/particle-v03/src/scene-models.js');
const materials=JSON.parse(await readFile(new URL('lib/materials-manifest.json',root),'utf8'));
const models=materials.models;
const modelSizes=Object.fromEntries(Object.entries(models).map(([id,url])=>[id,materials.files.find(file=>file.name===url.split('/').pop()).bytes]));
await writeFile(new URL('src/generated-assets.js',base),`export const icons=${JSON.stringify(icons)};export const modelBytes=${JSON.stringify(models)};export const modelSizes=${JSON.stringify(modelSizes)};\n`);
const bundle=await build({absWorkingDir:decodeURIComponent(root.pathname),entryPoints:['lib/client/particle-v03/src/entry.js'],bundle:true,write:false,minify:true,format:'iife',target:'chrome110',legalComments:'inline'});
let css=(await read('src/style.css')).toString()+'\n'+(await read('src/experience-v05.css')).toString();
for(const match of [...css.matchAll(/url\('assets\/([^']+)'\)/g)]){const name=match[1],url=materials.aliases['particle/'+name];if(!url)throw Error('Missing material mapping: '+name);css=css.replaceAll(match[0],`url('${url}')`)}
const js=bundle.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
const html=(await read('src/index.html')).toString().replace('@@STYLE@@',()=>css).replace('@@SCRIPT@@',()=>js);
await writeFile(new URL('lib/client/particle-v03-document.mjs',root),`// Generated document. Optional local artwork is served separately from code.\nexport const PARTICLE_V03_DOCUMENT = ${JSON.stringify(html)}\n`);
const evidence=qaOutput('particle-v03');
await writeFile(evidence+'/integrated.html',html);
await writeFile(evidence+'/build.json',JSON.stringify({version:'0.5',date:'2026-11-05',bytes:Buffer.byteLength(html),sha256:createHash('sha256').update(html).digest('hex'),cssSha256:createHash('sha256').update(css).digest('hex'),three:'0.180.0'},null,2));
console.log('Built particle 0.5 document: '+Buffer.byteLength(html)+' bytes');
