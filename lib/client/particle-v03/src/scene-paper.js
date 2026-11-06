// Colours are adapted from getSiPaperPalette's accepted paper and ink tokens.
export const PAPER_DEFAULTS = { paperEnabled: false, paperBrightness: 55 };
export function normalizePaper(value = {}) {
 const n=value.paperBrightness;
 return { paperEnabled:value.paperEnabled===true, paperBrightness:typeof n==='number'&&Number.isFinite(n)?Math.round(Math.max(0,Math.min(100,n))):PAPER_DEFAULTS.paperBrightness };
}
const rgb=c=>[1,3,5].map(i=>parseInt(c.slice(i,i+2),16));
const mix=(a,b,t)=>'#'+rgb(a).map((v,i)=>Math.round(v+(rgb(b)[i]-v)*t).toString(16).padStart(2,'0')).join('');
const luminance=c=>rgb(c).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
export function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
export function scenePaperPalette(brightness,side='#ddd8cc') {
 const n=normalizePaper({paperBrightness:brightness}).paperBrightness;
 // 0: accepted night paper; 65: original painting-paper side; 100: current day side.
 const bg=n<=65?mix('#30332f','#b8b2a6',n/65):mix('#b8b2a6',side,(n-65)/35);
 let light=contrast(bg,'#ebe6d9')>contrast(bg,'#263e3e');
 let text=light?'#ebe6d9':'#263e3e';
 // Mid paper tones need stronger ink than the original palette can supply.
 if(contrast(bg,text)<4.5){light=contrast(bg,'#ffffff')>contrast(bg,'#000000');text=light?'#ffffff':'#000000'}
 return {bg,text,muted:text,accent:light?'#8cc7c5':'#256d71',line:light?'#b6c1b8':'#58645e',light};
}
