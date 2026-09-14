/**
 * UI panel for the P12 (pre-life chemistry) and P13 (multi-cellular
 * colonial organisms) subsystems. The panel wires three controllers
 * into the main UI:
 *
 *   - `chemistryLoad` / `chemistryStep` for the reactor
 *   - `coloniesLoad` / `coloniesMaintain` for the colonial registry
 *   - the `internalTick` auto-step integration in the controller
 *     means the user can choose to run a planetary tick and have the
 *     chemistry / colonies subsystems advance in lockstep without
 *     clicking the per-step buttons. The panel just stops sending
 *     per-step requests; the controller does the rest.
 *
 * Cumulative state is read from the projection payload (the
 * controller packs the latest chemistry / colonies snapshot into
 * every projection), so the UI can render without re-asking.
 */
import type { Projection } from '../workers/controller.ts';

type Send = (type: string, payload?: Record<string, unknown>) => Promise<unknown>;

/**
 * The P12 chemistry + P13 colonies panel is now an
 * `explore-stage-panel` `<section>` rather than a `<dialog>`,
 * so we expose a small "back to planet" callback that hides
 * the stage and re-shows the planet view. The controller-side
 * `send('pause')` call is preserved — running the chemistry
 * reactor while the user is mid-flow on a different surface
 * is a confusing UX.
 */
export function mountPrebiotic(
  send: Send,
  onStatus: (msg: string, isError?: boolean) => void,
  onClose: () => void = () => undefined,
): (snapshot: Projection) => void {
  const SAMPLE_NETWORK = {
    species: ['A', 'B', 'C'],
    reactions: [
      { id: 'combine', reactants: ['A', 'B'], products: ['C', 'C'], rate: 0.1, energyJPerMole: -100 },
      { id: 'pumpA',   reactants: [],          products: ['A'],    rate: 1.0,  energyJPerMole: 50 },
      { id: 'decayC',  reactants: ['C'],       products: [],       rate: 0.05, energyJPerMole: 0 },
    ],
  };
  const SAMPLE_INITIAL = { A: 1, B: 1, C: 0 };
  const dialog = document.getElementById('prebiotic-dialog') as HTMLElement;
  const networkEl = document.getElementById('chem-network') as HTMLTextAreaElement;
  const chemStatus = document.getElementById('chem-status')!;
  const chemList = document.getElementById('chem-concentrations')!;
  const colStatus = document.getElementById('col-status')!;
  const colList = document.getElementById('col-list')!;
  const minMembersEl = document.getElementById('col-min-members') as HTMLInputElement;
  const fissionMembersEl = document.getElementById('col-fission-members') as HTMLInputElement;
  const maintenanceEl = document.getElementById('col-maintenance') as HTMLInputElement;

  const format = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const exp = (n: number) => n.toExponential(2);

  function setChemStatus(msg: string, isError = false) {
    chemStatus.textContent = msg;
    chemStatus.className = isError ? 'muted small' : 'muted small';
  }
  function setColStatus(msg: string, isError = false) {
    colStatus.textContent = msg;
    colStatus.className = isError ? 'muted small' : 'muted small';
  }

  document.getElementById('chem-load-sample')!.addEventListener('click', () => {
    networkEl.value = JSON.stringify({ network: SAMPLE_NETWORK, initial: SAMPLE_INITIAL, energyInJ: 1000 }, null, 2);
    setChemStatus('已填入示例网络 · 可直接点击「加载网络」');
  });
  document.getElementById('close-prebiotic')!.addEventListener('click', () => {
    void send('pause');
    onClose();
  });

  document.getElementById('chem-load')!.addEventListener('click', () => {
    let parsed: { network?: unknown; initial?: Record<string, number>; energyInJ?: number };
    try { parsed = JSON.parse(networkEl.value); }
    catch (e) { setChemStatus(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`, true); return; }
    if (!parsed.network || typeof parsed.network !== 'object') { setChemStatus('缺少 network 字段', true); return; }
    void send('chemistryLoad', { network: parsed.network, initial: parsed.initial ?? {}, energyInJ: parsed.energyInJ ?? 0 })
      .then(() => { setChemStatus('反应网络已加载 · 点击「推进 1 步」开始演化'); onStatus('反应网络已加载'); })
      .catch((e) => { setChemStatus(`加载失败：${e instanceof Error ? e.message : String(e)}`, true); });
  });
  document.getElementById('chem-step')!.addEventListener('click', () => {
    void send('chemistryStep', {})
      .then((payload: unknown) => {
        const p = payload as { status?: string; step?: number; energyConsumedJ?: number; energyShortfallJ?: number } | undefined;
        setChemStatus(`已推进 · 第 ${p?.step ?? 0} 步 · 状态 ${p?.status ?? '?'} · 本步消耗 ${exp(p?.energyConsumedJ ?? 0)} J · 欠能 ${exp(p?.energyShortfallJ ?? 0)} J`);
      })
      .catch((e) => { setChemStatus(`推进失败：${e instanceof Error ? e.message : String(e)}`, true); });
  });

  document.getElementById('col-load')!.addEventListener('click', () => {
    const minMembers = Math.max(1, Math.floor(Number(minMembersEl.value) || 2));
    const fissionMembers = Math.max(2, Math.floor(Number(fissionMembersEl.value) || 8));
    const maintenance = Math.max(0, Number(maintenanceEl.value) || 1);
    void send('coloniesLoad', { config: { minMembers, fissionMembers, fissionCooldown: 50, maintenanceJPerMember: maintenance, admissibleTraitIds: [] } })
      .then((payload: unknown) => {
        const p = payload as { total?: number; colonisedCohorts?: number } | undefined;
        setColStatus(`已扫描世界 · 形成 ${p?.total ?? 0} 个聚落 · 覆盖 ${p?.colonisedCohorts ?? 0} 个队列`);
        onStatus(`已形成 ${p?.total ?? 0} 个聚落`);
      })
      .catch((e) => { setColStatus(`加载失败：${e instanceof Error ? e.message : String(e)}`, true); });
  });
  document.getElementById('col-maintain')!.addEventListener('click', () => {
    void send('coloniesMaintain', {})
      .then((payload: unknown) => {
        const p = payload as { total?: number; dissolved?: string[]; fissioned?: number; totalMaintenanceJ?: number } | undefined;
        setColStatus(`维护完成 · 当前 ${p?.total ?? 0} 个聚落 · 本次解散 ${p?.dissolved?.length ?? 0} · 分裂 ${p?.fissioned ?? 0} · 累计维护 ${exp(p?.totalMaintenanceJ ?? 0)} J`);
      })
      .catch((e) => { setColStatus(`维护失败：${e instanceof Error ? e.message : String(e)}`, true); });
  });

  return (snapshot: Projection) => {
    // Chemistry
    if (snapshot.chemistry) {
      const c = snapshot.chemistry;
      chemList.replaceChildren();
      if (Object.keys(c.concentrations).length === 0) {
        const li = document.createElement('li'); li.className = 'muted'; li.textContent = '无物种'; chemList.append(li);
      } else {
        for (const [name, value] of Object.entries(c.concentrations)) {
          const li = document.createElement('li');
          const left = document.createElement('strong'); left.textContent = name;
          const right = document.createElement('span'); right.className = 'muted'; right.textContent = format(value);
          li.append(left, right);
          chemList.append(li);
        }
      }
      if (chemStatus.textContent === '尚未加载反应网络。' || chemStatus.textContent.startsWith('已推进')) {
        setChemStatus(`已加载 · 第 ${c.step} 步 · 状态 ${c.status} · 累计消耗 ${exp(c.totalConsumedJ)} J · 累计欠能 ${exp(c.totalShortfallJ)} J`);
      }
    } else {
      chemList.replaceChildren();
      const li = document.createElement('li'); li.className = 'muted';
      li.innerHTML = '未加载 · 点击左上「<b>载入示例网络</b>」填入 + 「<b>加载网络</b>」开始';
      chemList.append(li);
    }
    // Colonies
    if (snapshot.colonies) {
      const c = snapshot.colonies;
      colList.replaceChildren();
      if (c.total === 0) {
        const li = document.createElement('li'); li.className = 'muted'; li.textContent = '当前无聚落（已全部解散或未形成）'; colList.append(li);
      } else {
        const li = document.createElement('li');
        const left = document.createElement('strong'); left.textContent = `现存聚落 ${c.total} 个`;
        const right = document.createElement('span'); right.className = 'muted'; right.textContent = `分裂 ${c.totalFissions} · 维护 ${exp(c.totalMaintenanceJ)} J`;
        li.append(left, right);
        colList.append(li);
      }
    } else {
      colList.replaceChildren();
      const li = document.createElement('li'); li.className = 'muted';
      li.innerHTML = '未加载 · 点击右上「<b>扫描世界并形成聚落</b>」开始';
      colList.append(li);
    }
  };
}
