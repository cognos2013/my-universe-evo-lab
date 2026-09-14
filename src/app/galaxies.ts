import type {galaxySummary} from '../simulation/cosmos/galaxies.ts';
type Summary=ReturnType<typeof galaxySummary>&{cancelled?:boolean};
export function mountGalaxies(
  send:(type:string,payload?:Record<string,unknown>)=>Promise<any>,
  onClose:()=>void=()=>undefined,
){
  const dialog=document.getElementById('galaxy-dialog') as HTMLElement,view=document.getElementById('galaxy-map')!,detail=document.getElementById('galaxy-detail')!;
  const picker=document.getElementById('galaxy-select') as HTMLSelectElement;
  picker.addEventListener('change',()=>{selected=picker.value;inspect();});
  let selected='halo-1',snapshot:Summary|null=null;
  const format=(n:number)=>n.toLocaleString('zh-CN',{maximumFractionDigits:1});
  function inspect(){
    if(!snapshot)return;const h=snapshot.halos.find(h=>h.id===selected)!;detail.replaceChildren();const title=document.createElement('h3');title.textContent=h.id;detail.append(title);
    if(h.positionKpc){const p=document.createElement('p');p.textContent=`位置 (${h.positionKpc.map(n=>n.toFixed(2)).join(', ')}) kpc · 速度 ${format(Math.hypot(...h.velocityKpcMyr!)*977.7922217)} km/s · 暗物质 ${format(h.darkMassSolar!)} M☉`;detail.append(p);}
    for(const [name,value]of [['热气体',`${format(h.hot)} M☉`],['冷气体',`${format(h.cold)} M☉`],['存活恒星质量',`${format(h.stars)} M☉`],['恒星遗迹',`${format(h.remnants)} M☉`],['估算总光度',`${format(h.light)} L☉`],['恒星群记录',`${h.populations} 组`],['冷却时间参数',`${format(h.coolingMyr)} Myr`]]){const p=document.createElement('p');p.textContent=`${name}：${value}`;detail.append(p);}
  }
  function render(s:Summary){snapshot=s;if(!s.halos.some(h=>h.id===selected))selected=s.halos[0]!.id;picker.replaceChildren();for(const h of s.halos){const option=document.createElement('option');option.value=h.id;option.textContent=h.id;picker.append(option);}picker.value=selected;document.getElementById('galaxy-age')!.textContent=`模型宇宙年龄 ${format(s.ageMyr)} 百万年`;
    document.getElementById('galaxy-summary')!.textContent=`有恒星的气体晕 ${s.galaxies} / ${s.halos.length} · 恒星质量 ${format(s.stars)} M☉ · 气体 ${format(s.gas)} M☉ · 遗迹 ${format(s.remnants)} M☉`;
    document.getElementById('galaxy-flux')!.textContent=`上一步形成 ${format(s.bornSolar)} M☉ 恒星，回流 ${format(s.returnedSolar)} M☉ 气体；质量账残差 ${s.residual.toExponential(2)} M☉`;
    document.getElementById('enable-gravity')!.hidden=s.dynamics!==null;
    document.getElementById('gravity-summary')!.textContent=s.dynamics?`局部孤立引力系统 · 视野半宽 ${format(s.dynamics.extentKpc)} kpc · 合并 ${s.dynamics.mergers.length} 次 · 总能量相对漂移 ${((s.dynamics.energy-s.dynamics.initialEnergy)/Math.max(1,Math.abs(s.dynamics.initialEnergy))).toExponential(2)}`:'旧版静态气体晕，可从当前状态启用引力；旧位置按预设尺度解释，初始速度设为零。';
    const events=document.getElementById('gravity-events')!;events.replaceChildren();
    for(const e of s.dynamics?.mergers??[]){const row=document.createElement('p');row.className='small muted';row.textContent=`${e.timeMyr.toFixed(2)} Myr：${e.parents.join(' + ')} → ${e.child} · ${format(e.massSolar)} M☉`;events.append(row);}
    view.replaceChildren();for(const h of s.halos){const b=document.createElement('button');b.className='halo-node';b.style.left=`${(h.x+1)*45+5}%`;b.style.top=`${(h.y+1)*40+10}%`;b.dataset.active=String(h.stars>0);b.textContent=h.id;b.setAttribute('aria-label',`观察 ${h.id}`);b.addEventListener('click',()=>{selected=h.id;picker.value=selected;inspect();});view.append(b);}inspect();
  }
  async function run(type:string,steps=1){
    document.querySelectorAll<HTMLButtonElement>('[data-galaxy-steps]').forEach(b=>b.disabled=true);
    document.getElementById('galaxy-status')!.textContent='正在计算…';
    try{const result:Summary=await send(type,{steps});render(result);document.getElementById('galaxy-status')!.textContent=result.cancelled?'已停止 · 保留最后完整天体时间步':'已完成 · 天体状态纳入完整实验存档；保存状态见主界面';}
    catch(error){document.getElementById('galaxy-status')!.textContent=error instanceof Error?error.message:String(error);try{render(await send('galaxies'));}catch{}}
    finally{document.querySelectorAll<HTMLButtonElement>('[data-galaxy-steps]').forEach(b=>b.disabled=false);}
  }
  // Populate the picker with the preset halo list immediately so
  // the user can see the 8 halos before any data arrives. The
  // handler below replaces this with the live list as soon as
  // the worker responds.
  picker.replaceChildren();
  for (let i = 1; i <= 8; i++) {
    const option = document.createElement('option');
    option.value = `halo-${i}`;
    option.textContent = `halo-${i}`;
    picker.append(option);
  }
  picker.value = selected;
  // Fetch the current astronomy state so the picker, halos, and
  // summary show real data the first time the user opens the
  // galaxy panel — not just the empty placeholders. The handler
  // is async-fire-and-forget; if it fails the preset list above
  // still gives the user a target to inspect.
  void (async () => {
    try {
      const result = await send('galaxies');
      render(result as Summary);
    } catch { /* preset list is the fallback */ }
  })();

  document.getElementById('open-galaxies')!.addEventListener('click',()=>{document.dispatchEvent(new Event('stop-cosmic-playback'));void run('galaxies');});
  // The button sits inside the cosmos panel; its scope is the
  // panel mount, so the explore host owns the activation. We
  // dispatch a custom event for any caller that wants to react.
  document.getElementById('open-galaxies')!.addEventListener('click',()=>{document.dispatchEvent(new CustomEvent('explore-activate',{detail:'galaxy'}));});
  document.getElementById('close-galaxies')!.addEventListener('click',()=>{void send('pause');onClose();});
  // `dialog` is now a `<section>` (UX-2.5); no `cancel` event.
  document.getElementById('enable-gravity')!.addEventListener('click',()=>void run('galaxiesGravity'));
  document.getElementById('stop-galaxies')!.addEventListener('click',()=>void send('pause'));
  document.querySelectorAll<HTMLButtonElement>('[data-galaxy-steps]').forEach(b=>b.addEventListener('click',()=>void run('galaxiesAdvance',Number(b.dataset.galaxySteps))));
}
