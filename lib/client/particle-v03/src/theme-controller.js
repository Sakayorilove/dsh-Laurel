// The outer document owns persistence and the full-shell transition.
import './ink/selection.js';
export function createThemeController({reduced,onChange}){
 const root=document.documentElement,button=document.querySelector('#theme-switch'),names={industrial:'原初工业',si:'祀'};
 let current=root.dataset.initialTheme==='si'?'si':'industrial',requested=current,mode=root.dataset.color==='light'?'light':'dark',epoch=0,disposed=false,adapter=null;
 function sync(next,color='dark'){
  if(disposed||!names[next])return;
  current=requested=next;mode=color;root.dataset.theme=next;root.dataset.color=color;root.dataset.revision='0.5';root.style.colorScheme=color;
  document.querySelector('#theme-name').textContent=names[next];button.setAttribute('aria-checked',String(next==='si'));button.title='切换至'+names[next==='si'?'industrial':'si'];button.dataset.theme=next;
  void window.syncSelectionTheme?.();
 }
 async function set(next,{animate=true}={}){if(disposed||!names[next])return;requested=next;epoch++;if(adapter&&animate)return adapter(next);sync(next,mode);onChange(next);}
 const click=()=>void set(requested==='si'?'industrial':'si').catch(()=>{});button.addEventListener('click',click);sync(current,mode);
 return{get current(){return current},set,sync,connect(fn){adapter=fn},finish(){window.InkMotion.configure({reduced:reduced()})},dispose(){disposed=true;epoch++;window.InkMotion.cancel();button.removeEventListener('click',click)},snapshot:()=>({current,requested,mode,phase:'host-owned',epoch})};
}
