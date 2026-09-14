/**
 * UI panel for P15 (settlements and civilisations).
 *
 * Wires `settlementLoad` / `settlementStep` into the main UI and
 * renders the cumulative state + per-settlement dashboard from
 * `Projection.settlement`. Settlement templates are independent
 * initialisations (per docs/15 P15) — the panel asks the user how
 * many to spawn and at what knowledge level, then maps that to
 * evenly-spaced cells across the world.
 */
import type { Projection } from '../workers/controller.ts';

type Send = (type: string, payload?: Record<string, unknown>) => Promise<unknown>;

export function mountSettlement(
  send: Send,
  onStatus: (msg: string, isError?: boolean) => void,
  onGenerateCityscape: ((settlementId: string, label: string) => void) | undefined,
  onClose: () => void = () => undefined,
): (snapshot: Projection, worldCells: number) => void {
  const dialog = document.getElementById('settlement-dialog') as HTMLElement;
  const countEl = document.getElementById('set-count') as HTMLSelectElement;
  const popEl = document.getElementById('set-population') as HTMLSelectElement;
  const knowledgeEl = document.getElementById('set-knowledge') as HTMLSelectElement;
  const foodEl = document.getElementById('set-food') as HTMLSelectElement;
  const instEl = document.getElementById('set-institution') as HTMLSelectElement;
  const taxrateEl = document.getElementById('set-taxrate') as HTMLInputElement;
  const techIrrigationEl = document.getElementById('set-tech-irrigation') as HTMLInputElement;
  const techGranaryEl = document.getElementById('set-tech-granary') as HTMLInputElement;
  const techWritingEl = document.getElementById('set-tech-writing') as HTMLInputElement;
  const exchangeEnabledEl = document.getElementById('set-exchange-enabled') as HTMLInputElement;
  const coalitionEnabledEl = document.getElementById('set-coalition-enabled') as HTMLInputElement;
  const conflictEnabledEl = document.getElementById('set-conflict-enabled') as HTMLInputElement;
  const statusEl = document.getElementById('set-status')!;
  const summaryEl = document.getElementById('set-summary')!;
  const bySettlementEl = document.getElementById('set-by-settlement')!;

  const format = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 1 });

  function setStatus(msg: string, isError = false) {
    statusEl.textContent = msg;
    statusEl.className = isError ? 'muted small' : 'muted small';
  }

  document.getElementById('close-settlement')!.addEventListener('click', () => {
    void send('pause');
    onClose();
  });

  document.getElementById('set-load')!.addEventListener('click', () => {
    const count = Number(countEl.value) || 3;
    const population = Number(popEl.value) || 50;
    const initialKnowledgeLevel = Number(knowledgeEl.value) || 0;
    const initialFood = Number(foodEl.value) || 200;
    const instKind = instEl.value as 'public' | 'private' | 'mixed';
    const taxRate = Math.max(0, Math.min(1, Number(taxrateEl.value) || 0));
    const unlocked: string[] = [];
    if (techIrrigationEl.checked) unlocked.push('irrigation');
    if (techGranaryEl.checked) unlocked.push('granary');
    if (techWritingEl.checked) unlocked.push('writing');
    const exchangeEnabled = exchangeEnabledEl.checked;
    const coalitionEnabled = coalitionEnabledEl.checked;
    const conflictEnabled = conflictEnabledEl.checked;
    void send('pause');
    const probe = (window as unknown as { __universeCellCount?: number }).__universeCellCount;
    const n = probe ?? 320;
    const labels: string[] = [];
    const templates: Array<Record<string, unknown>> = [];
    for (let i = 0; i < count; i++) {
      const cellIndex = Math.floor((i + 0.5) * n / count);
      const label = `聚落 ${i + 1}`;
      labels.push(label);
      templates.push({
        label,
        cellIndex,
        population,
        initialFood,
        initialKnowledgeLevel,
        institution: { kind: instKind, taxRate },
        technology: { unlocked },
      });
    }
    // If exchange enabled, build a *chain* of edges: i → (i+1) % N
    // with rate 5. A chain keeps the edge count low while still
    // exercising the rescue path.
    if (exchangeEnabled && count > 1) {
      for (let i = 0; i < count; i++) {
        const srcLabel = labels[i]!;
        const dstLabel = labels[(i + 1) % count]!;
        const src = templates[i] as Record<string, unknown>;
        src.exchangeTo = [{ targetLabel: dstLabel, ratePerStep: 5 }];
      }
    }
    // Phase 3: coalition chain (rate 3) — symmetric, exercises
    // the unconditional shared pool.
    if (coalitionEnabled && count > 1) {
      for (let i = 0; i < count; i++) {
        const dstLabel = labels[(i + 1) % count]!;
        const src = templates[i] as Record<string, unknown>;
        src.coalitionTo = [{ targetLabel: dstLabel, ratePerStep: 3 }];
      }
    }
    // Phase 3: conflict — pair every adjacent pair (i, i+1) with
    // 5% per-step casualty + 2% population.
    if (conflictEnabled && count > 1) {
      for (let i = 0; i < count; i++) {
        const dstLabel = labels[(i + 1) % count]!;
        const src = templates[i] as Record<string, unknown>;
        src.conflictTo = [{ targetLabel: dstLabel, probability: 0.05, casualtyFraction: 0.02, damageFood: 5 }];
      }
    }
    void send('settlementLoad', { templates, config: {} })
      .then((payload: unknown) => {
        const p = payload as { settlements?: number } | undefined;
        const techs = unlocked.length === 0 ? '无' : unlocked.join('/');
        const ex = exchangeEnabled ? `· 链式互助 ${count} 条边` : '';
        const co = coalitionEnabled ? '· 联盟' : '';
        const cf = conflictEnabled ? '· 冲突' : '';
        setStatus(`已加载 · ${p?.settlements ?? 0} 个聚落 · 制度 ${instKind} · 技术 ${techs} ${ex}${co}${cf}`);
        onStatus(`P15 已加载 ${p?.settlements ?? 0} 个聚落`);
      })
      .catch((e) => setStatus(`加载失败：${e instanceof Error ? e.message : String(e)}`, true));
  });
  document.getElementById('set-step')!.addEventListener('click', () => {
    void send('settlementStep', {})
      .then((payload: unknown) => {
        const p = payload as { step?: number; settlements?: number; totalProduced?: number; totalConsumed?: number; totalDissolutions?: number } | undefined;
        setStatus(`已推进 · 第 ${p?.step ?? 0} 步 · 当前 ${p?.settlements ?? 0} 个聚落 · 累计生产 ${format(p?.totalProduced ?? 0)} · 累计消费 ${format(p?.totalConsumed ?? 0)} · 累计解散 ${p?.totalDissolutions ?? 0}`);
      })
      .catch((e) => setStatus(`推进失败：${e instanceof Error ? e.message : String(e)}`, true));
  });

  function setSummaryRow(ul: HTMLElement, label: string, value: string) {
    const li = document.createElement('li');
    const left = document.createElement('strong'); left.textContent = label;
    const right = document.createElement('span'); right.className = 'muted'; right.textContent = value;
    li.append(left, right);
    ul.append(li);
  }

  return (snapshot: Projection, worldCells: number) => {
    // Record the latest cell count so the load button can use it.
    (window as unknown as { __universeCellCount?: number }).__universeCellCount = worldCells;
    if (!snapshot.settlement) {
      summaryEl.replaceChildren();
      setSummaryRow(summaryEl, 'settlements', '—');
      setSummaryRow(summaryEl, 'step', '—');
      setSummaryRow(summaryEl, '累计生产 food', '—');
      setSummaryRow(summaryEl, '累计消费 food', '—');
      setSummaryRow(summaryEl, '累计互助 food', '—');
      setSummaryRow(summaryEl, '累计解散', '—');
      bySettlementEl.replaceChildren();
      const li = document.createElement('li'); li.className = 'muted';
      li.innerHTML = '未加载 · 点击左上「<b>扫描世界并形成聚落</b>」载入独立模板';
      bySettlementEl.append(li);
      return;
    }
    const c = snapshot.settlement;
    summaryEl.replaceChildren();
    setSummaryRow(summaryEl, 'settlements', String(c.settlements));
    setSummaryRow(summaryEl, 'step', String(c.step));
    setSummaryRow(summaryEl, '累计生产 food', format(c.totalProducedFood));
    setSummaryRow(summaryEl, '累计消费 food', format(c.totalConsumedFood));
    setSummaryRow(summaryEl, '累计互助 food', `${format(c.totalExchangeFood)} (${c.exchanges} 条边)`);
    setSummaryRow(summaryEl, '累计解散', String(c.totalDissolutions));
    bySettlementEl.replaceChildren();
    if (c.bySettlement.length === 0) {
      const li = document.createElement('li'); li.className = 'muted'; li.textContent = '所有聚落已解散';
      bySettlementEl.append(li);
    } else {
      for (const row of c.bySettlement) {
        const li = document.createElement('li');
        const top = document.createElement('div'); top.className = 'set-row-top';
        const left = document.createElement('strong'); left.textContent = `${row.label} · cell ${row.cellIndex} · pop ${row.population} · 制度 ${row.institutionKind} · ${row.techCount} tech`;
        const right = document.createElement('span');
        right.className = row.dissolved ? 'muted dissolved' : 'muted';
        right.textContent = row.dissolved
          ? `已解散 · 存活 ${row.lifetimeSteps} 步`
          : `food ${row.food} · 知识 L${row.knowledgeLevel} · 收/发 ${row.totalReceivedFood}/${row.totalSentFood}`;
        top.append(left, right);
        li.append(top);
        if (onGenerateCityscape && !row.dissolved) {
          const actions = document.createElement('div');
          actions.className = 'set-snap-actions';
          const btn = document.createElement('button');
          btn.className = 'text-button';
          btn.textContent = '📷 生成 3D 天际线';
          btn.addEventListener('click', () => onGenerateCityscape(row.id, row.label));
          actions.append(btn);
          li.append(actions);
        }
        bySettlementEl.append(li);
      }
    }
  };
}
