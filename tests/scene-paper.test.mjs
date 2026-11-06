import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePaper,scenePaperPalette,contrast} from '../lib/client/particle-v03/src/scene-paper.js';
test('paper preferences opt in, clamp and reject malformed stored values',()=>{
 assert.deepEqual(normalizePaper(),{paperEnabled:false,paperBrightness:55});
 for(const bad of [null,'20',NaN,Infinity])assert.equal(normalizePaper({paperBrightness:bad}).paperBrightness,55);
 assert.deepEqual(normalizePaper({paperEnabled:'true',paperBrightness:-2}),{paperEnabled:false,paperBrightness:0});
 assert.equal(normalizePaper({paperBrightness:105}).paperBrightness,100);
});
test('painting paper endpoints preserve the existing palette and choose the clearest ink',()=>{
 assert.equal(scenePaperPalette(0).bg,'#30332f');assert.equal(scenePaperPalette(65).bg,'#b8b2a6');assert.equal(scenePaperPalette(100,'#ddd8cc').bg,'#ddd8cc');
 for(let n=0;n<=100;n++){const p=scenePaperPalette(n);assert.ok(contrast(p.bg,p.text)>=4.5,`brightness ${n}`)}
});
