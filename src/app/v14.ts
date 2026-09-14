/**
 * UI panel for V14 — the 3D visual route.
 *
 * Per docs/04 the real World Labs / Marble / Atlas / Spark APIs
 * require API key + commercial agreement. The router at
 * `src/simulation/visual/router.ts` ships an honest in-repo
 * procedural backend (5 kinds: terrain / tree / building / rock /
 * humanoid) and honest stubs for the three commercial backends
 * that throw with a clear message.
 *
 * This panel drives a 3-column dialog:
 *
 *   [ generation controls ] | [ snapshot list, grouped by branch ] | [ 3D view (single) ]
 *                                                                 [ 3D view (compare) ]
 *
 * The 3D renderer is built on Three.js (already used by the planet
 * view in `src/rendering/planet.ts` so the dependency is paid for).
 * Each canvas owns a `THREE.WebGLRenderer` + `OrbitControls`, and
 * the meshes come straight from the snapshot's `Float32Array` of
 * vertices + colours + `Uint32Array` of indices. Phase 2 dropped
 * the Canvas 2D painter from v14-1; everything is real GPU now.
 *
 * F: snapshots are grouped by `createdAtBranch` in the middle
 *    column, and the compare-mode selector spans all branches so
 *    the user can contrast, say, a "rocky coast" snapshot from
 *    `main` with a "smooth coast" snapshot from a fork branch.
 *
 * G: the left column has a collapsible "batch parameter scan"
 *    section. The user picks a subset of kinds / styles / seeds /
 *    resolution; the controller runs the sweep and replies with
 *    a `V14BatchReport` (counts + histograms + stats) plus the
 *    new snapshot ids. The UI renders the histograms as inline
 *    SVGs and shows the stats as a `<ul>`.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Projection } from '../workers/controller.ts';
import type { ProceduralKind, V14Backend, V14BatchReport, V14BatchScanSpec, V14Snapshot, V14SnapshotSummary, V14WorldResult, V14WorldSpec } from '../simulation/visual/types.ts';
import { ALL_PROCEDURAL_KINDS } from '../simulation/visual/types.ts';

type Send = (type: string, payload?: Record<string, unknown>) => Promise<unknown>;

type CanvasRole = 'single' | 'compare-left' | 'compare-right';

interface CanvasCtx {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  mesh: THREE.Mesh | null;
  frameId: number | null;
  currentSnapshotId: string | null;
  role: CanvasRole;
}

export function mountV14(
  send: Send,
  onStatus: (msg: string, isError?: boolean) => void,
  onClose: () => void = () => undefined,
): {
  render: (snapshot: Projection) => void;
  /**
   * Pre-fill the form with a `cityscape` spec for the given
   * P15 settlement, open the dialog, and auto-trigger
   * generation. The P15 "📷 生成 3D 天际线" button is the
   * only caller; the controller's `handleV14Generate` looks
   * up the settlement + cell data and passes it to the
   * `inRepo` cityscape generator.
   */
  prefillCityscape: (settlementId: string, label: string) => void;
} {
  const dialog = document.getElementById('v14-dialog') as HTMLElement;
  const kindEl = document.getElementById('v14-kind') as HTMLSelectElement;
  const styleEl = document.getElementById('v14-style') as HTMLSelectElement;
  const resEl = document.getElementById('v14-resolution') as HTMLInputElement;
  const seedModeEl = document.getElementById('v14-seed-mode') as HTMLSelectElement;
  const promptEl = document.getElementById('v14-prompt') as HTMLInputElement;
  const fixedSeedEl = document.getElementById('v14-fixed-seed') as HTMLInputElement;
  const labelEl = document.getElementById('v14-label') as HTMLInputElement;
  const generateBtn = document.getElementById('v14-generate') as HTMLButtonElement;
  const statusEl = document.getElementById('v14-status')!;
  const listEl = document.getElementById('v14-list')!;
  const metaEl = document.getElementById('v14-meta')!;
  const bannerEl = document.getElementById('v14-banner')!;
  const singlePane = document.getElementById('v14-single-pane') as HTMLElement;
  const comparePane = document.getElementById('v14-compare-pane') as HTMLElement;
  const compareToggleBtn = document.getElementById('v14-compare-toggle') as HTMLButtonElement;
  const compareLeftSelect = document.getElementById('v14-compare-left') as HTMLSelectElement;
  const compareRightSelect = document.getElementById('v14-compare-right') as HTMLSelectElement;
  const canvasSingle = document.getElementById('v14-canvas') as HTMLCanvasElement;
  const canvasLeft = document.getElementById('v14-canvas-left') as HTMLCanvasElement;
  const canvasRight = document.getElementById('v14-canvas-right') as HTMLCanvasElement;
  // Batch parameter scan (G) DOM references.
  const batchKindsEl = document.getElementById('v14-batch-kinds') as HTMLSelectElement;
  const batchStylesEl = document.getElementById('v14-batch-styles') as HTMLSelectElement;
  const batchSeedsEl = document.getElementById('v14-batch-seeds') as HTMLInputElement;
  const batchResEl = document.getElementById('v14-batch-resolution') as HTMLSelectElement;
  const batchLabelPrefixEl = document.getElementById('v14-batch-label-prefix') as HTMLInputElement;
  const batchRunBtn = document.getElementById('v14-batch-run') as HTMLButtonElement;
  const batchClearBtn = document.getElementById('v14-batch-clear') as HTMLButtonElement;
  const batchStatusEl = document.getElementById('v14-batch-status')!;
  const batchOutputEl = document.getElementById('v14-batch-output') as HTMLElement;
  const batchSummaryEl = document.getElementById('v14-batch-summary')!;
  const batchHistKind = document.getElementById('v14-batch-hist-kind') as unknown as SVGSVGElement;
  const batchHistStyle = document.getElementById('v14-batch-hist-style') as unknown as SVGSVGElement;
  const batchHistVertex = document.getElementById('v14-batch-hist-vertex') as unknown as SVGSVGElement;
  const batchHistDuration = document.getElementById('v14-batch-hist-duration') as unknown as SVGSVGElement;

  // Cached snapshot list mirror — the canonical store is on the
  // worker book. We only need this for the UI's "select / delete
  // / rename" interactions; the projection's `v14.snapshots` is
  // the authoritative source for redraws.
  let snapshots: V14SnapshotSummary[] = [];
  let activeId: string | null = null;
  let byBranch: Record<string, number> = {};
  let compareMode = false;
  let compareLeftId: string | null = null;
  let compareRightId: string | null = null;
  const format = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });

  // The 3D canvases. We initialise them lazily so the dialog can
  // be opened / closed without paying the WebGL context cost each
  // time (browsers cap concurrent WebGL contexts).
  const singleCtx: CanvasCtx = makeCanvasCtx(canvasSingle, 'single');
  const leftCtx: CanvasCtx = makeCanvasCtx(canvasLeft, 'compare-left');
  const rightCtx: CanvasCtx = makeCanvasCtx(canvasRight, 'compare-right');

  function makeCanvasCtx(canvas: HTMLCanvasElement, role: CanvasRole): CanvasCtx {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(0x080e17, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    // Soft warm rim + cool fill so the colours are readable even
    // when the model is dark.
    scene.add(new THREE.AmbientLight(0xa6d8e5, 1.2));
    const key = new THREE.DirectionalLight(0xfff2d8, 2.2); key.position.set(-3, 4, 4); scene.add(key);
    const fill = new THREE.DirectionalLight(0x48b4a8, 0.7); fill.position.set(2, 0, -2); scene.add(fill);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
    camera.position.set(0, 0.3, 3.0);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 0.4;
    controls.maxDistance = 12;
    controls.rotateSpeed = 0.7;
    return { canvas, renderer, scene, camera, controls, mesh: null, frameId: null, currentSnapshotId: null, role };
  }

  function frameLoop(ctx: CanvasCtx) {
    if (ctx.frameId !== null) return;
    const tick = () => {
      ctx.controls.update();
      ctx.renderer.render(ctx.scene, ctx.camera);
      if (!dialog.hidden && ctx.canvas.isConnected) {
        ctx.frameId = requestAnimationFrame(tick);
      } else {
        ctx.frameId = null;
      }
    };
    ctx.frameId = requestAnimationFrame(tick);
  }

  function resizeRenderer(ctx: CanvasCtx) {
    const rect = ctx.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (ctx.canvas.width !== w) ctx.canvas.width = w;
    if (ctx.canvas.height !== h) ctx.canvas.height = h;
    ctx.renderer.setSize(w, h, false);
    ctx.camera.aspect = w / h;
    ctx.camera.updateProjectionMatrix();
  }

  function disposeMesh(ctx: CanvasCtx) {
    if (ctx.mesh) {
      ctx.scene.remove(ctx.mesh);
      ctx.mesh.geometry.dispose();
      const mat = ctx.mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
      ctx.mesh = null;
    }
  }

  function buildMeshFromResult(r: V14WorldResult): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    // Three.js's `BufferAttribute` constructor copies the typed
    // array's contents into a fresh buffer. Float32Array and
    // Uint32Array are accepted directly.
    geometry.setAttribute('position', new THREE.BufferAttribute(r.vertices, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(r.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(r.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.65,
      metalness: 0.05,
      flatShading: false,
    });
    return new THREE.Mesh(geometry, material);
  }

  function frameCamera(ctx: CanvasCtx, radius: number) {
    // Place the camera far enough that the model's bounding sphere
    // fits in the smaller canvas dimension. Pulling back 3× the
    // radius leaves comfortable headroom for the directional light
    // and any HUD overlays.
    const d = Math.max(0.5, radius * 3.0);
    ctx.camera.position.set(0, 0.3 * d, d);
    ctx.controls.target.set(0, 0, 0);
    ctx.controls.update();
  }

  /**
   * Render a snapshot into one of the three canvases. The snapshot
   * is looked up from the book (passed in) so we always pull the
   * full mesh — the projection channel only carries summaries.
   */
  async function renderSnapshot(ctx: CanvasCtx, snapId: string) {
    const snap = await fetchSnapshot(snapId);
    if (!snap) {
      disposeMesh(ctx);
      ctx.currentSnapshotId = null;
      return;
    }
    if (ctx.currentSnapshotId === snapId && ctx.mesh) return; // already showing it
    disposeMesh(ctx);
    const mesh = buildMeshFromResult({
      backend: snap.backend,
      sourceLabel: snap.sourceLabel,
      vertices: snap.vertices,
      colors: snap.colors,
      indices: snap.indices,
      boundingRadius: snap.boundingRadius,
      durationMs: snap.durationMs,
    });
    ctx.scene.add(mesh);
    ctx.mesh = mesh;
    ctx.currentSnapshotId = snapId;
    resizeRenderer(ctx);
    frameCamera(ctx, snap.boundingRadius);
    frameLoop(ctx);
  }

  /**
   * Fetch a full V14Snapshot from the worker. The worker holds
   * the canonical book on its side and exposes a dedicated
   * `v14Get` request that returns the single requested snapshot
   * (full mesh + summary). This avoids the round-trip through
   * `export` → `ExperimentBook.import` that the previous
   * implementation used, which was brittle against codec /
   * ruleset-hash mismatches when the worker had bumped its
   * rules but the main thread was still on the old one.
   */
  async function fetchSnapshot(snapId: string): Promise<V14Snapshot | null> {
    try {
      const reply = (await send('v14Get', { id: snapId })) as { snapshot: V14Snapshot | null } | undefined;
      if (!reply || !reply.snapshot) {
        onStatus(`V14 快照 ${snapId} 不存在`, true);
        return null;
      }
      return reply.snapshot;
    } catch (e) {
      onStatus(`读取 V14 快照失败：${e instanceof Error ? e.message : String(e)}`, true);
      return null;
    }
  }

  function setStatus(msg: string, isError = false) {
    statusEl.textContent = msg;
    statusEl.style.color = isError ? '#e2a3a3' : '';
  }

  function renderList() {
    listEl.replaceChildren();
    if (snapshots.length === 0) {
      const li = document.createElement('li');
      li.className = 'muted small';
      li.textContent = '尚无快照。在左侧生成一个开始。';
      listEl.append(li);
      return;
    }
    // Group by createdAtBranch (F). Within each group, newest
    // first. Branch groups themselves are ordered by the
    // most-recent snapshot timestamp (also newest first).
    const groups = new Map<string, V14SnapshotSummary[]>();
    for (const s of snapshots) {
      const key = s.createdAtBranch ?? '<no-branch>';
      const list = groups.get(key);
      if (list) list.push(s); else groups.set(key, [s]);
    }
    const orderedGroups = [...groups.entries()].sort((a, b) => {
      const aMax = Math.max(...a[1].map((s) => s.createdAtMs));
      const bMax = Math.max(...b[1].map((s) => s.createdAtMs));
      return bMax - aMax;
    });
    for (const [branch, list] of orderedGroups) {
      const head = document.createElement('li');
      head.className = 'v14-branch-head';
      const branchLabel = branch === '<no-branch>' ? '无分支' : branch;
      head.innerHTML = `<span class="v14-branch-name">${branchLabel}</span><span class="v14-branch-count muted small">${list.length} 快照</span>`;
      listEl.append(head);
      const ordered = [...list].sort((a, b) => b.createdAtMs - a.createdAtMs);
      for (const s of ordered) {
        const li = document.createElement('li');
        li.className = 'v14-snap' + (s.id === activeId ? ' active' : '');
        li.tabIndex = 0;
        const title = document.createElement('div');
        title.className = 'v14-snap-label';
        title.textContent = s.label;
        const detail = document.createElement('div');
        detail.className = 'v14-snap-detail muted small';
        const tickPart = s.createdAtTick === null ? '无 tick' : `tick ${s.createdAtTick}`;
        detail.textContent = `${tickPart} · ${s.spec.kind}/${s.spec.style}/${s.spec.resolution} · ${format(s.vertexCount)} 顶点`;
        const actions = document.createElement('div');
        actions.className = 'v14-snap-actions';
        const selectBtn = document.createElement('button');
        selectBtn.className = 'text-button';
        selectBtn.textContent = s.id === activeId ? '当前' : '选中';
        selectBtn.addEventListener('click', (e) => { e.stopPropagation(); void doSelect(s.id); });
        const renameBtn = document.createElement('button');
        renameBtn.className = 'text-button';
        renameBtn.textContent = '改名';
        renameBtn.addEventListener('click', (e) => { e.stopPropagation(); doRename(s.id); });
        const delBtn = document.createElement('button');
        delBtn.className = 'text-button';
        delBtn.textContent = '删除';
        delBtn.addEventListener('click', (e) => { e.stopPropagation(); void doDelete(s.id); });
        actions.append(selectBtn, renameBtn, delBtn);
        li.append(title, detail, actions);
        li.addEventListener('click', () => void doSelect(s.id));
        listEl.append(li);
      }
    }
  }

  function renderMeta() {
    metaEl.replaceChildren();
    const active = snapshots.find((s) => s.id === activeId) ?? null;
    if (!active) {
      addMetaRow('当前快照', '—');
      addMetaRow('kind / style / res', '—');
      addMetaRow('vertices', '—');
      addMetaRow('triangles', '—');
      addMetaRow('bbox radius', '—');
      addMetaRow('source', '—');
      bannerEl.textContent = 'Backend: —';
      return;
    }
    addMetaRow('当前快照', active.label);
    addMetaRow('kind / style / res', `${active.spec.kind} / ${active.spec.style} / ${active.spec.resolution}`);
    addMetaRow('vertices', format(active.vertexCount));
    addMetaRow('triangles', format(active.indexCount / 3));
    addMetaRow('bbox radius', format(active.boundingRadius));
    addMetaRow('source', active.sourceLabel);
    bannerEl.textContent = `Backend: ${active.backend} · source: ${active.sourceLabel}`;
  }

  function addMetaRow(label: string, value: string, cls = 'muted') {
    const li = document.createElement('li');
    const l = document.createElement('strong'); l.textContent = label;
    const r = document.createElement('span'); r.className = cls; r.textContent = value;
    li.append(l, r);
    metaEl.append(li);
  }

  function renderCompareSelects() {
    // F: every snapshot is selectable regardless of branch; we
    // prefix the option label with the branch id so the user can
    // pick a "fork-1 / smooth" snapshot for the left side and
    // a "main / rocky" snapshot for the right side without
    // guessing.
    const opts = snapshots.map((s) => {
      const o = document.createElement('option');
      o.value = s.id;
      const branchPart = s.createdAtBranch ? `[${s.createdAtBranch}] ` : '';
      o.textContent = `${branchPart}${s.label} · ${s.spec.kind}`;
      return o;
    });
    compareLeftSelect.replaceChildren(...opts);
    compareRightSelect.replaceChildren(...opts);
    if (compareLeftId && snapshots.some((s) => s.id === compareLeftId)) {
      compareLeftSelect.value = compareLeftId;
    } else if (snapshots.length > 0) {
      compareLeftId = snapshots[0]!.id;
      compareLeftSelect.value = compareLeftId;
    }
    if (compareRightId && snapshots.some((s) => s.id === compareRightId)) {
      compareRightSelect.value = compareRightId;
    } else if (snapshots.length > 1) {
      compareRightId = snapshots[1]!.id;
      compareRightSelect.value = compareRightId;
    } else if (snapshots.length > 0) {
      compareRightId = snapshots[0]!.id;
      compareRightSelect.value = compareRightId;
    }
  }

  function setCompareMode(on: boolean) {
    compareMode = on;
    singlePane.hidden = on;
    comparePane.hidden = !on;
    compareToggleBtn.textContent = on ? '退出对比' : '对比两个快照';
    if (on) {
      renderCompareSelects();
      if (compareLeftId) void renderSnapshot(leftCtx, compareLeftId);
      if (compareRightId) void renderSnapshot(rightCtx, compareRightId);
    } else {
      if (activeId) void renderSnapshot(singleCtx, activeId);
    }
  }

  async function doSelect(id: string) {
    try {
      const reply = (await send('v14Select', { id })) as { snapshots?: V14SnapshotSummary[]; activeId?: string | null } | undefined;
      if (reply?.snapshots) {
        snapshots = reply.snapshots;
        activeId = reply.activeId ?? null;
      }
      renderList();
      renderMeta();
      if (!compareMode && activeId) await renderSnapshot(singleCtx, activeId);
    } catch (e) {
      onStatus(`切换 V14 快照失败：${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  async function doDelete(id: string) {
    if (!confirm('删除此 V14 快照？此操作不可撤销。')) return;
    try {
      const reply = (await send('v14Delete', { id })) as { snapshots?: V14SnapshotSummary[]; activeId?: string | null } | undefined;
      if (reply?.snapshots) {
        snapshots = reply.snapshots;
        activeId = reply.activeId ?? null;
      }
      // Clear the mesh on any canvas that was showing the deleted
      // snapshot.
      for (const ctx of [singleCtx, leftCtx, rightCtx]) {
        if (ctx.currentSnapshotId === id) {
          disposeMesh(ctx);
          ctx.currentSnapshotId = null;
        }
      }
      renderList();
      renderMeta();
      if (compareMode) renderCompareSelects();
      else if (activeId) void renderSnapshot(singleCtx, activeId);
    } catch (e) {
      onStatus(`删除 V14 快照失败：${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  function doRename(id: string) {
    const cur = snapshots.find((s) => s.id === id);
    const next = prompt('新标签：', cur?.label ?? '');
    if (next === null) return;
    const label = next.trim().slice(0, 80);
    if (label.length === 0) {
      onStatus('标签不能为空', true);
      return;
    }
    void send('v14Rename', { id, label })
      .then((reply) => {
        const r = reply as { snapshots?: V14SnapshotSummary[]; activeId?: string | null } | undefined;
        if (r?.snapshots) {
          snapshots = r.snapshots;
          activeId = r.activeId ?? null;
        }
        renderList();
        renderMeta();
      })
      .catch((e) => onStatus(`改名失败：${e instanceof Error ? e.message : String(e)}`, true));
  }

  generateBtn.addEventListener('click', () => {
    const kind = kindEl.value as ProceduralKind;
    const style = styleEl.value as V14WorldSpec['style'];
    const resolution = Math.max(4, Math.min(256, Math.floor(Number(resEl.value) || 32)));
    const prompt = promptEl.value.trim() || 'demo';
    const mode = seedModeEl.value;
    let seed: string | undefined;
    if (mode === 'fixed') seed = fixedSeedEl.value.trim() || 'v14-demo-1';
    else if (mode === 'prompt') seed = prompt;
    const spec: V14WorldSpec = { prompt, kind, resolution, style };
    if (seed !== undefined) spec.seed = seed;
    const label = labelEl.value.trim();
    const payload: Record<string, unknown> = { ...spec };
    if (label.length > 0) payload.label = label;
    setStatus('生成中…');
    generateBtn.disabled = true;
    void send('v14Generate', payload)
      .then((reply) => {
        const r = reply as { snapshot?: V14Snapshot; activeId?: string | null; snapshots?: V14SnapshotSummary[] } | undefined;
        const newSnap = r?.snapshot;
        if (newSnap) {
          // The full snapshot is in the reply; we also want the
          // updated list. If the reply doesn't carry the list, the
          // next projection will sync it.
          const summary: V14SnapshotSummary = {
            id: newSnap.id, label: newSnap.label,
            createdAtTick: newSnap.createdAtTick, createdAtBranch: newSnap.createdAtBranch,
            spec: newSnap.spec, backend: newSnap.backend, sourceLabel: newSnap.sourceLabel,
            vertexCount: newSnap.vertices.length / 3, indexCount: newSnap.indices.length,
            boundingRadius: newSnap.boundingRadius, durationMs: newSnap.durationMs,
            createdAtMs: newSnap.createdAtMs,
          };
          // Replace any existing entry with the same id (avoid
          // duplicates if the projection already carries it), then
          // make sure activeId is current.
          const without = snapshots.filter((s) => s.id !== summary.id);
          snapshots = [...without, summary];
          activeId = r?.activeId ?? summary.id;
        } else if (r?.snapshots) {
          snapshots = r.snapshots;
          activeId = r.activeId ?? null;
        }
        renderList();
        renderMeta();
        if (compareMode) {
          renderCompareSelects();
          if (compareLeftId) void renderSnapshot(leftCtx, compareLeftId);
          if (compareRightId) void renderSnapshot(rightCtx, compareRightId);
        } else if (activeId) {
          void renderSnapshot(singleCtx, activeId);
        }
        setStatus(`已生成 · ${newSnap?.label ?? 'snapshot'}`);
      })
      .catch((e) => {
        setStatus(`生成失败：${e instanceof Error ? e.message : String(e)}`, true);
        onStatus(`V14 生成失败：${e instanceof Error ? e.message : String(e)}`, true);
      })
      .finally(() => { generateBtn.disabled = false; });
  });

  compareToggleBtn.addEventListener('click', () => setCompareMode(!compareMode));
  compareLeftSelect.addEventListener('change', () => {
    compareLeftId = compareLeftSelect.value;
    if (compareLeftId) void renderSnapshot(leftCtx, compareLeftId);
  });
  compareRightSelect.addEventListener('change', () => {
    compareRightId = compareRightSelect.value;
    if (compareRightId) void renderSnapshot(rightCtx, compareRightId);
  });

  // === Batch parameter scan (G) =====================================

  /**
   * Render a single bar chart into an SVG. The SVG viewBox is
   * `0 0 320 120` so the same CSS sizes scale freely. Each
   * label is rendered below the bar (rotated 0°); if there are
   * many bins we switch to a "…" truncation so the chart
   * doesn't blow up.
   */
  function drawHistogram(svg: SVGSVGElement, bins: { label: string; count: number }[], color: string) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const W = 320, H = 120, padTop = 6, padBottom = 22, padLeft = 4, padRight = 4;
    const innerW = W - padLeft - padRight;
    const innerH = H - padTop - padBottom;
    const max = Math.max(1, ...bins.map((b) => b.count));
    const n = Math.max(1, bins.length);
    const barW = innerW / n;
    for (let i = 0; i < bins.length; i++) {
      const b = bins[i]!;
      const h = (b.count / max) * innerH;
      const x = padLeft + i * barW + 1;
      const y = padTop + (innerH - h);
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', String(Math.max(1, barW - 2)));
      rect.setAttribute('height', String(Math.max(1, h)));
      rect.setAttribute('fill', color);
      rect.setAttribute('opacity', b.count === 0 ? '0.25' : '0.95');
      svg.append(rect);
      // Value label above the bar.
      if (b.count > 0) {
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('x', String(x + (barW - 2) / 2));
        t.setAttribute('y', String(y - 2));
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('font-size', '9');
        t.setAttribute('fill', '#cfe4dd');
        t.textContent = String(b.count);
        svg.append(t);
      }
      // X-axis label below.
      const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      lbl.setAttribute('x', String(x + (barW - 2) / 2));
      lbl.setAttribute('y', String(padTop + innerH + 12));
      lbl.setAttribute('text-anchor', 'middle');
      lbl.setAttribute('font-size', '8');
      lbl.setAttribute('fill', '#7eb3ad');
      // Truncate long labels so a 16-bin chart stays readable.
      lbl.textContent = b.label.length > 8 ? b.label.slice(0, 7) + '…' : b.label;
      svg.append(lbl);
    }
  }

  function renderBatchReport(report: V14BatchReport) {
    batchOutputEl.hidden = false;
    batchSummaryEl.replaceChildren();
    addBatchRow('总运行数', String(report.totalRuns));
    addBatchRow('seed × kind × style', `${report.snapshotIds.length} 条快照`);
    addBatchRow('总耗时', `${format(report.totalDurationMs)} ms`);
    addBatchRow('顶点 均值 / 中位', `${format(report.vertexStats.mean)} / ${format(report.vertexStats.median)}`);
    addBatchRow('耗时 均值 / 中位', `${report.durationStats.mean.toFixed(2)} / ${report.durationStats.median.toFixed(2)} ms`);
    addBatchRow('开始于', report.startedAtTick === null ? '无 tick' : `tick ${report.startedAtTick} · ${report.startedAtBranch ?? '无 branch'}`);
    // Histograms.
    const kindBins = (['terrain', 'tree', 'building', 'rock', 'humanoid'] as ProceduralKind[]).map((k) => ({
      label: k,
      count: report.perKind[k] ?? 0,
    }));
    const styleBins = (['smooth', 'rocky', 'crystal', 'organic'] as V14WorldSpec['style'][]).map((s) => ({
      label: s,
      count: report.perStyle[s] ?? 0,
    }));
    drawHistogram(batchHistKind, kindBins, '#6de5c4');
    drawHistogram(batchHistStyle, styleBins, '#a6d8e5');
    drawHistogram(batchHistVertex, report.vertexHistogram, '#5ce1c1');
    drawHistogram(batchHistDuration, report.durationHistogram, '#d4a574');
  }

  function addBatchRow(label: string, value: string) {
    const li = document.createElement('li');
    const l = document.createElement('strong'); l.textContent = label;
    const r = document.createElement('span'); r.className = 'muted'; r.textContent = value;
    li.append(l, r);
    batchSummaryEl.append(li);
  }

  function readSelected<K extends string>(el: HTMLSelectElement, valid: readonly K[]): K[] {
    const out: K[] = [];
    for (const opt of Array.from(el.selectedOptions)) {
      if ((valid as readonly string[]).includes(opt.value)) out.push(opt.value as K);
    }
    return out;
  }

  batchRunBtn.addEventListener('click', () => {
    const kinds = readSelected(batchKindsEl, ALL_PROCEDURAL_KINDS);
    const styles = readSelected(batchStylesEl, ['smooth', 'rocky', 'crystal', 'organic'] as const);
    const seedCount = Math.max(1, Math.min(16, Math.floor(Number(batchSeedsEl.value) || 4)));
    const seeds = Array.from({ length: seedCount }, (_, i) => i);
    const resolution = Math.max(4, Math.min(256, Math.floor(Number(batchResEl.value) || 16)));
    const labelPrefix = batchLabelPrefixEl.value.trim();
    if (kinds.length === 0) {
      batchStatusEl.textContent = '至少选择 1 个 kind';
      batchStatusEl.style.color = '#e2a3a3';
      return;
    }
    if (styles.length === 0) {
      batchStatusEl.textContent = '至少选择 1 个 style';
      batchStatusEl.style.color = '#e2a3a3';
      return;
    }
    const spec: V14BatchScanSpec = {
      prompt: 'batch',
      seeds,
      kinds,
      styles,
      resolution,
      ...(labelPrefix ? { labelPrefix } : {}),
    };
    const total = seeds.length * kinds.length * styles.length;
    batchStatusEl.textContent = `扫描中… ${total} 次生成`;
    batchStatusEl.style.color = '';
    batchRunBtn.disabled = true;
    void send('v14BatchScan', spec as unknown as Record<string, unknown>)
      .then((reply) => {
        const r = reply as { report?: V14BatchReport; snapshots?: V14SnapshotSummary[]; activeId?: string | null } | undefined;
        if (r?.report) {
          if (r.snapshots) {
            snapshots = r.snapshots;
            activeId = r.activeId ?? activeId;
          }
          renderBatchReport(r.report);
          batchStatusEl.textContent = `完成 · ${r.report.totalRuns} 次 · ${format(r.report.totalDurationMs)} ms · ${Object.keys(byBranch).length} 个 branch`;
          renderList();
          onStatus(`V14 扫描完成 · ${r.report.totalRuns} 次`);
        } else {
          batchStatusEl.textContent = '完成（无报告）';
        }
      })
      .catch((e) => {
        batchStatusEl.textContent = `失败：${e instanceof Error ? e.message : String(e)}`;
        batchStatusEl.style.color = '#e2a3a3';
        onStatus(`V14 扫描失败：${e instanceof Error ? e.message : String(e)}`, true);
      })
      .finally(() => { batchRunBtn.disabled = false; });
  });

  batchClearBtn.addEventListener('click', () => {
    batchOutputEl.hidden = true;
    batchSummaryEl.replaceChildren();
    batchStatusEl.textContent = '已清除显示（快照仍保留在列表）。';
    batchStatusEl.style.color = '';
  });

  document.getElementById('close-v14')!.addEventListener('click', () => {
    void send('pause');
    // The V14 panel used to be a `<dialog>` and relied on the
    // `close` event to cancel the GPU frame loops. Now that
    // it's an explore-stage `<section>`, we cancel here and
    // notify the explore host.
    if (singleCtx.frameId !== null) { cancelAnimationFrame(singleCtx.frameId); singleCtx.frameId = null; }
    if (leftCtx.frameId !== null) { cancelAnimationFrame(leftCtx.frameId); leftCtx.frameId = null; }
    if (rightCtx.frameId !== null) { cancelAnimationFrame(rightCtx.frameId); rightCtx.frameId = null; }
    onClose();
  });
  // Resize handlers — debounced to once per frame so window
  // resizes don't spam the GPU.
  let resizeTicking = false;
  function scheduleResize() {
    if (resizeTicking) return;
    resizeTicking = true;
    requestAnimationFrame(() => {
      resizeTicking = false;
      if (compareMode) {
        resizeRenderer(leftCtx);
        resizeRenderer(rightCtx);
        if (leftCtx.mesh) frameCamera(leftCtx, leftCtx.mesh.geometry.boundingSphere?.radius ?? 1);
        if (rightCtx.mesh) frameCamera(rightCtx, rightCtx.mesh.geometry.boundingSphere?.radius ?? 1);
      } else {
        resizeRenderer(singleCtx);
        if (singleCtx.mesh) frameCamera(singleCtx, singleCtx.mesh.geometry.boundingSphere?.radius ?? 1);
      }
    });
  }

  function render(proj: Projection) {
    // Sync from the projection channel (the canonical source of
    // truth for the snapshot list). We replace the cached list
    // when the controller publishes; user-initiated changes push
    // through the v14List reply and are already reflected here.
    if (proj.v14 && Array.isArray(proj.v14.snapshots)) {
      const list = proj.v14.snapshots;
      const sameLength = list.length === snapshots.length;
      // The byBranch histogram is the cheapest cross-check we
      // can do to detect a list change without traversing the
      // whole array.
      const byBranchJson = JSON.stringify(byBranch);
      const projByBranchJson = JSON.stringify(proj.v14.byBranch ?? {});
      if (!sameLength || proj.v14.activeId !== activeId || byBranchJson !== projByBranchJson) {
        snapshots = list;
        activeId = proj.v14.activeId;
        byBranch = proj.v14.byBranch ?? {};
        const listCountEl = document.getElementById('v14-list-count');
        if (listCountEl) {
          const branchCount = Object.keys(byBranch).length;
          listCountEl.textContent = branchCount > 1 ? ` · ${snapshots.length} 条 / ${branchCount} 分支` : ` · ${snapshots.length} 条`;
        }
        renderList();
        renderMeta();
        if (compareMode) {
          renderCompareSelects();
          if (compareLeftId) void renderSnapshot(leftCtx, compareLeftId);
          if (compareRightId) void renderSnapshot(rightCtx, compareRightId);
        } else if (activeId) {
          void renderSnapshot(singleCtx, activeId);
        }
        return;
      }
    }
    if (!dialog.hidden) {
      scheduleResize();
      if (compareMode) {
        if (leftCtx.frameId === null) frameLoop(leftCtx);
        if (rightCtx.frameId === null) frameLoop(rightCtx);
      } else if (singleCtx.frameId === null) {
        frameLoop(singleCtx);
      }
    }
  }

  /**
   * I: pre-fill the form for a P15 settlement's cityscape and
   * immediately fire the generate handler. The controller
   * resolves the rest of the city spec (population, knowledge,
   * cell area, nutrient) on the worker side so the UI just
   * needs to send `kind: 'cityscape'` + `city.settlementId`.
   */
  function prefillCityscape(settlementId: string, label: string) {
    kindEl.value = 'cityscape';
    // The cityscape generator picks its own palette / roof style
    // from the settlement state; the style select is a no-op
    // for this kind but we set it to a sensible default so the
    // form doesn't visually contradict the spec.
    if (styleEl.value !== 'smooth') styleEl.value = 'smooth';
    // The kind drives everything else; the user can still tweak
    // the resolution before / after the auto-generate.
    labelEl.value = `cityscape · ${label}`;
    setStatus(`已为聚落 "${label}" 预填 cityscape 参数,生成中…`);
    // Fire the same generate handler the user would.
    generateBtn.click();
  }

  return { render, prefillCityscape };
}
