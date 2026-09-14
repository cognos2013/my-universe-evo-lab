/**
 * UI panel for P14 (perception / learning / intelligent behaviour).
 *
 * The panel wires three controllers into the main UI:
 *
 *   - `cognitionLoad`: scan the active world, attach one agent per
 *     cohort, and bind them to a chosen task (foraging /
 *     thermoregulation / aggregation).
 *   - `cognitionStep`: advance the registry one step. The policy
 *     (Q-learning or random) is selected at load time and persists
 *     across steps.
 *   - `internalTick` auto-step: closing the dialog and clicking
 *     "▶ 开始演化" on the main UI lets the planetary tick advance
 *     every subsystem in lockstep. The P14 auto-step is silent
 *     (no per-step reply); the cumulative snapshot is read from
 *     `Projection.cognition` instead.
 *
 * The right-hand pane shows the cumulative snapshot and a
 * per-lineage roll-up — enough for the user to watch Q-learning
 * converge (avg reward rises; Q-table fills up to the 256-entry
 * memory bound) and to compare lineages in the multi-agent
 * aggregation task.
 */
import type { Projection } from '../workers/controller.ts';

type Send = (type: string, payload?: Record<string, unknown>) => Promise<unknown>;
type TaskKind = 'foraging' | 'thermoregulation' | 'aggregation';
type PolicyName = 'q-learning' | 'random';

const TASK_LABELS: Record<TaskKind, string> = {
  foraging: '觅食',
  thermoregulation: '避热',
  aggregation: '社交',
};
const POLICY_LABELS: Record<PolicyName, string> = {
  'q-learning': 'Q-learning',
  random: '随机基线',
};

export function mountCognition(
  send: Send,
  onStatus: (msg: string, isError?: boolean) => void,
  onClose: () => void = () => undefined,
): (snapshot: Projection) => void {
  const dialog = document.getElementById('cognition-dialog') as HTMLElement;
  const taskEl = document.getElementById('cog-task') as HTMLSelectElement;
  const policyEl = document.getElementById('cog-policy') as HTMLSelectElement;
  const epsilonEl = document.getElementById('cog-epsilon') as HTMLInputElement;
  const statusEl = document.getElementById('cog-status')!;
  const summaryEl = document.getElementById('cog-summary')!;
  const byLineageEl = document.getElementById('cog-by-lineage')!;

  const exp = (n: number) => n.toExponential(2);
  const format = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });

  function setStatus(msg: string, isError = false) {
    statusEl.textContent = msg;
    statusEl.className = isError ? 'muted small' : 'muted small';
  }

  document.getElementById('close-cognition')!.addEventListener('click', () => {
    void send('pause');
    onClose();
  });

  document.getElementById('cog-load')!.addEventListener('click', () => {
    const task = (taskEl.value as TaskKind);
    const policy = (policyEl.value as PolicyName);
    const epsilon0 = Math.max(0, Math.min(1, Number(epsilonEl.value) || 0.2));
    void send('cognitionLoad', { task, policy, epsilon0 })
      .then((payload: unknown) => {
        const p = payload as { agents?: number; taskKind?: TaskKind } | undefined;
        setStatus(`已加载 · 任务 ${TASK_LABELS[task]} · 策略 ${POLICY_LABELS[policy]} · 形成 ${p?.agents ?? 0} 个 agents`);
        onStatus(`P14 已加载 ${p?.agents ?? 0} 个 agents`);
      })
      .catch((e) => setStatus(`加载失败：${e instanceof Error ? e.message : String(e)}`, true));
  });
  document.getElementById('cog-step')!.addEventListener('click', () => {
    void send('cognitionStep', {})
      .then((payload: unknown) => {
        const p = payload as { agents?: number; totalReward?: number; spentThisStep?: number; episode?: number; taskKind?: TaskKind } | undefined;
        const taskLabel = TASK_LABELS[(p?.taskKind as TaskKind) ?? 'foraging'];
        setStatus(`已推进 · 第 ${p?.episode ?? 0} 步 · 任务 ${taskLabel} · 本步扣 ${exp(p?.spentThisStep ?? 0)} J · 累计 reward ${format(p?.totalReward ?? 0)}`);
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

  return (snapshot: Projection) => {
    if (!snapshot.cognition) {
      summaryEl.replaceChildren();
      setSummaryRow(summaryEl, 'agents', '—');
      setSummaryRow(summaryEl, 'episode', '—');
      setSummaryRow(summaryEl, '累计 reward', '—');
      setSummaryRow(summaryEl, '累计 cognition J', '—');
      setSummaryRow(summaryEl, '当前任务', '—');
      byLineageEl.replaceChildren();
      const li = document.createElement('li'); li.className = 'muted'; li.textContent = '未加载 agents';
      byLineageEl.append(li);
      return;
    }
    const c = snapshot.cognition;
    summaryEl.replaceChildren();
    setSummaryRow(summaryEl, 'agents', String(c.agents));
    setSummaryRow(summaryEl, 'episode', String(c.episode));
    setSummaryRow(summaryEl, '累计 reward', format(c.totalReward));
    setSummaryRow(summaryEl, '累计 cognition J', exp(c.totalCognitionJ));
    setSummaryRow(summaryEl, '当前任务', TASK_LABELS[c.taskKind] ?? c.taskKind);
    byLineageEl.replaceChildren();
    if (c.byLineage.length === 0) {
      const li = document.createElement('li'); li.className = 'muted'; li.textContent = '尚无 agents';
      byLineageEl.append(li);
    } else {
      for (const row of c.byLineage) {
        const li = document.createElement('li');
        const left = document.createElement('strong'); left.textContent = `${row.lineageId} · ${row.agents} agents`;
        const right = document.createElement('span'); right.className = 'muted';
        right.textContent = `avg ${format(row.avgReward)} · Q ${row.totalQEntries}`;
        li.append(left, right);
        byLineageEl.append(li);
      }
    }
  };
}
