import {cosmicBackground,presentAgeGyr} from '../simulation/cosmos/background.ts';

/** Shared-day playback; deep-time exploration remains explicitly separate. */
export function mountCosmos(
  pause:()=>Promise<unknown>,
  step:()=>Promise<unknown>,
  tick:()=>number,
  onClose:()=>void=()=>undefined,
){
  const dialog=document.getElementById('cosmos-dialog') as HTMLElement;
  const canvas=document.getElementById('cosmos-canvas') as HTMLCanvasElement;
  const age=document.getElementById('cosmos-age') as HTMLInputElement;
  const ctx=canvas.getContext('2d')!;
  const linked=document.getElementById('cosmos-linked') as HTMLInputElement;
  let generation=0,busy=false;
  let angle=0,zoom=1,playing=false,last=0,frame=0;
  let seed=8401;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const tracers=Array.from({length:1600},()=>[random()*2-1,random()*2-1,random()*2-1]);
  function draw(){
    age.disabled=linked.checked;
    if(linked.checked)age.value=String(presentAgeGyr+tick()/365.25/1e9);
    document.getElementById('cosmos-sync-status')!.textContent=linked.checked?`同步时刻 · 星球第 ${tick()} 日 · 宇宙自参考年代经过 ${tick()} 日`:'快速背景浏览：不计算星球的亿年生态历史';
    const state=cosmicBackground(Number(age.value));
    const rect=canvas.getBoundingClientRect(),w=rect.width,h=rect.height;if(!w||!h)return;
    const dpr=Math.min(devicePixelRatio,2);canvas.width=w*dpr;canvas.height=h*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.fillStyle='#070d19';ctx.fillRect(0,0,w,h);
    const unit=Math.min(w,h)*.32*zoom;
    ctx.strokeStyle='#284353';ctx.lineWidth=1;
    for(let i=-4;i<=4;i++){ctx.beginPath();ctx.moveTo(w/2+i*unit/2,0);ctx.lineTo(w/2+i*unit/2,h);ctx.stroke();ctx.beginPath();ctx.moveTo(0,h/2+i*unit/2);ctx.lineTo(w,h/2+i*unit/2);ctx.stroke();}
    for(const [x,y,z]of tracers){
      const rx=x!*Math.cos(angle)-z!*Math.sin(angle),depth=x!*Math.sin(angle)+z!*Math.cos(angle);
      ctx.fillStyle=`rgba(130,202,225,${.2+(depth+1)*.3})`;ctx.beginPath();ctx.arc(w/2+rx*unit*state.scaleFactor,h/2+y!*unit*state.scaleFactor,1+(depth+1)*.45,0,Math.PI*2);ctx.fill();
    }
    ctx.fillStyle='#9fbfc9';ctx.font='12px sans-serif';ctx.fillText(`标尺每格 150 Mpc · 固定物理窗口`,18,h-20);
    document.getElementById('cosmos-time')!.textContent=`宇宙年龄 ${(state.ageGyr*10).toFixed(2)} 亿年`;
    document.getElementById('cosmos-scale')!.textContent=state.scaleFactor.toFixed(3);
    document.getElementById('cosmos-hubble')!.textContent=state.hubbleKmPerSecondMpc.toFixed(1);
    document.getElementById('cosmos-density')!.textContent=`${state.relativeMatterDensity.toFixed(3)} ×`;
    document.getElementById('cosmos-matter')!.textContent=`${(state.matterFraction*100).toFixed(1)}%`;
    document.getElementById('cosmos-lambda')!.textContent=`${(state.lambdaFraction*100).toFixed(1)}%`;
  }
  function stop(){playing=false;generation++;cancelAnimationFrame(frame);(document.getElementById('cosmos-play') as HTMLButtonElement).disabled=busy;document.getElementById('cosmos-play')!.textContent=linked.checked?'▶ 同步推进宇宙与星球':'▶ 推进宇宙背景';}
  function animate(now:number){if(!playing)return;const dt=Math.min((now-last)/1000,.1);last=now;age.value=String(Math.min(30,Number(age.value)+dt));draw();if(Number(age.value)>=30)stop();else frame=requestAnimationFrame(animate);}
  async function advanceLinked(token:number){
    if(!playing||token!==generation||!linked.checked)return;
    busy=true;
    try{await step();draw();if(playing&&token===generation)setTimeout(()=>void advanceLinked(token),120);}
    catch(error){stop();document.getElementById('cosmos-sync-status')!.textContent=`同步暂停：${error instanceof Error?error.message:String(error)} 两者均保留最后完整时刻。`;}
    finally{busy=false;(document.getElementById('cosmos-play') as HTMLButtonElement).disabled=false;}
  }
  document.addEventListener('stop-cosmic-playback',stop);
  linked.addEventListener('change',()=>{stop();draw();});
  age.value=String(presentAgeGyr);age.addEventListener('input',()=>{stop();draw();});
  document.getElementById('open-cosmos')!.addEventListener('click',()=>{void pause().then(()=>{stop();draw();}).catch(()=>{});});
  document.getElementById('close-cosmos')!.addEventListener('click',()=>{stop();onClose();});
  document.getElementById('cosmos-planet')!.addEventListener('click',()=>{stop();onClose();});
  // `dialog` is now a `<section>` (UX-2.5), so the browser
  // doesn't fire a `close` event. The previous cancel/close
  // listeners are replaced with onClose() invocations above.
  document.getElementById('cosmos-now')!.addEventListener('click',()=>{stop();age.value=String(presentAgeGyr);draw();});
  document.getElementById('cosmos-play')!.addEventListener('click',()=>{if(playing){stop();return;}if(busy)return;if(linked.checked){playing=true;document.getElementById('cosmos-play')!.textContent='Ⅱ 暂停同步推进';void advanceLinked(++generation);return;}if(Number(age.value)>=30)age.value='0.1';playing=true;last=performance.now();document.getElementById('cosmos-play')!.textContent='Ⅱ 暂停宇宙背景';frame=requestAnimationFrame(animate);});
  let dragging=false,previousX=0;
  canvas.addEventListener('pointerdown',e=>{dragging=true;previousX=e.clientX;canvas.setPointerCapture(e.pointerId);});
  canvas.addEventListener('pointermove',e=>{if(dragging){angle+=(e.clientX-previousX)*.005;previousX=e.clientX;draw();}});
  canvas.addEventListener('pointerup',()=>{dragging=false;});canvas.addEventListener('pointercancel',()=>{dragging=false;});
  canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=Math.max(.2,Math.min(4,zoom*Math.exp(-e.deltaY*.001)));draw();},{passive:false});
  new ResizeObserver(()=>{if(!dialog.hidden)draw();}).observe(canvas);
}
