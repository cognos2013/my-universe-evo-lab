/**
 * UI panel for P16 (real-Earth data and calibration).
 *
 * Wires `earthDataLoad` (load the in-repo synthetic Holocene
 * series) and `earthDataCompare` (run a calibration against a
 * model trajectory) into the main UI. The model trajectory in
 * phase 1 is a placeholder: we synthesise a "constant 288 K"
 * trajectory sampled at the Earth's tick days. A real
 * multi-seed batch (P17) is what would make this useful for
 * scientific claims; the UI exposes the framework so the
 * wiring is in place.
 */
import type { Projection } from '../workers/controller.ts';

type Send = (type: string, payload?: Record<string, unknown>) => Promise<unknown>;

export function mountEarth(
  send: Send,
  onStatus: (msg: string, isError?: boolean) => void,
  onClose: () => void = () => undefined,
): (snapshot: Projection) => void {
  const dialog = document.getElementById('earth-dialog') as HTMLElement;
  const trainEl = document.getElementById('earth-train') as HTMLInputElement;
  const baselineEl = document.getElementById('earth-baseline') as HTMLSelectElement;
  const quantityEl = document.getElementById('earth-quantity') as HTMLSelectElement;
  const statusEl = document.getElementById('earth-status')!;
  const summaryEl = document.getElementById('earth-summary')!;

  const exp = (n: number) => n.toExponential(2);
  const format = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });

  function setStatus(msg: string, isError = false) {
    statusEl.textContent = msg;
    statusEl.className = isError ? 'muted small' : 'muted small';
  }
  function setSummaryRow(ul: HTMLElement, label: string, value: string, cls = 'muted') {
    const li = document.createElement('li');
    const left = document.createElement('strong'); left.textContent = label;
    const right = document.createElement('span'); right.className = cls; right.textContent = value;
    li.append(left, right);
    ul.append(li);
  }

  document.getElementById('close-earth')!.addEventListener('click', () => {
    void send('pause');
    onClose();
  });

  document.getElementById('earth-load-sample')!.addEventListener('click', () => {
    void send('earthDataLoad', { useSample: true })
      .then((payload: unknown) => {
        const p = payload as { citation?: string; points?: number; gapFillCount?: number } | undefined;
        setStatus(`已加载 · ${p?.citation ?? '?'} · ${p?.points ?? 0} 点 · 缺测 ${p?.gapFillCount ?? 0}`);
        onStatus(`P16 已加载参考数据`);
      })
      .catch((e) => setStatus(`加载失败：${e instanceof Error ? e.message : String(e)}`, true));
  });

  document.getElementById('earth-run')!.addEventListener('click', () => {
    const train = Math.max(0.5, Math.min(0.95, Number(trainEl.value) || 0.7));
    const baseline = (baselineEl.value as 'constant-mean' | 'linear-trend' | 'persistence');
    const quantity = (quantityEl.value as 'temperatureK' | 'seaLevelM' | 'co2ppm' | 'iceCoverageFrac');
    // Phase 1 placeholder model: a "constant 288 K" trajectory
    // sampled at every 100th point of the loaded series. A real
    // implementation would feed a multi-seed batch (P17).
    void send('earthDataLoad', { useSample: true })
      .then(() => {
        // Read the series back from the projection so the model's
        // tick days match the Earth's. The projection carries the
        // citation / start / end; we re-construct sampling points.
        const probe = (window as unknown as { __lastEarthSeries?: { startTickDays: number; endTickDays: number } }).__lastEarthSeries;
        const start = probe?.startTickDays ?? 0;
        const end = probe?.endTickDays ?? 10_000 * 365;
        const model: { tickDays: number; value: number }[] = [];
        const n = 200;
        for (let i = 0; i < n; i++) {
          const tickDays = start + (i + 0.5) * (end - start) / n;
          // Placeholder: 288 K constant.
          model.push({ tickDays, value: 288 });
        }
        return send('earthDataCompare', {
          model,
          config: { trainFraction: train, baseline, quantity },
        });
      })
      .then((payload: unknown) => {
        const p = payload as { calibration?: { calibratedRMSE: number; baselineRMSE: number; calibratedMAE: number; baselineMAE: number; beatsBaseline: boolean; baseline: string; quantity: string; holdoutN: number; trainN: number } } | undefined;
        if (p?.calibration) {
          const c = p.calibration;
          setStatus(`校准完成 · ${c.trainN}/${c.holdoutN} train/holdout · baseline=${c.baseline} · quantity=${c.quantity} · ${c.beatsBaseline ? '胜出 ✓' : '未胜出'}`);
        } else {
          setStatus('校准完成');
        }
        onStatus('P16 校准已运行');
      })
      .catch((e) => setStatus(`校准失败：${e instanceof Error ? e.message : String(e)}`, true));
  });

  return (snapshot: Projection) => {
    if (!snapshot.earthData) {
      summaryEl.replaceChildren();
      setSummaryRow(summaryEl, '数据源', '—');
      setSummaryRow(summaryEl, '点数', '—');
      setSummaryRow(summaryEl, '区间', '—');
      setSummaryRow(summaryEl, '缺测', '—');
      setSummaryRow(summaryEl, '校准 RMSE', '—');
      setSummaryRow(summaryEl, '基线 RMSE', '—');
      setSummaryRow(summaryEl, '是否胜出', '—');
      return;
    }
    const e = snapshot.earthData;
    (window as unknown as { __lastEarthSeries?: { startTickDays: number; endTickDays: number } }).__lastEarthSeries = {
      startTickDays: e.startTickDays,
      endTickDays: e.endTickDays,
    };
    summaryEl.replaceChildren();
    setSummaryRow(summaryEl, '数据源', e.citation);
    setSummaryRow(summaryEl, '点数', String(e.points));
    setSummaryRow(summaryEl, '区间', `${e.startTickDays} → ${e.endTickDays} d`);
    setSummaryRow(summaryEl, '缺测', String(e.gapFillCount));
    if (e.calibration) {
      setSummaryRow(summaryEl, '校准 RMSE', format(e.calibration.calibratedRMSE));
      setSummaryRow(summaryEl, '基线 RMSE', format(e.calibration.baselineRMSE));
      setSummaryRow(summaryEl, '是否胜出', e.calibration.beatsBaseline ? '是 ✓' : '否', e.calibration.beatsBaseline ? 'win' : 'muted');
    } else {
      setSummaryRow(summaryEl, '校准 RMSE', '—');
      setSummaryRow(summaryEl, '基线 RMSE', '—');
      setSummaryRow(summaryEl, '是否胜出', '—');
    }
  };
}
