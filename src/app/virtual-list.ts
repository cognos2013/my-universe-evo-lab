/**
 * Tiny virtualized list for fixed-height rows.
 *
 * Two modes:
 *
 * 1. **Soft virtualize (default for small lists)**: All `<li>`
 *    nodes are mounted in the document flow. The container
 *    uses its own CSS flex / gap layout. No spacer or pool is
 *    created, so the list integrates with any normal list
 *    styles. The point of running through this class is to
 *    have a single update path that the caller doesn't have
 *    to branch on.
 *
 * 2. **Windowed virtualize (large lists)**: When the total
 *    item height exceeds the container's scroll viewport,
 *    only the rows in `[scrollTop / itemHeight - overscan,
 *    scrollTop / itemHeight + visibleCount + overscan]` are
 *    mounted, and a tall spacer reserves the scroll geometry.
 *    This is the mode that pays off when the list grows past
 *    a few dozen items.
 *
 * `setItems` always rebuilds the visible window. The
 * container is the scroll viewport; callers are expected to
 * give it `position: relative` and a fixed height when
 * windowing is needed.
 */

export interface VirtualListOptions {
  container: HTMLElement;
  itemHeight: number;
  overscan?: number;
  /** When true, always mount every row (skip the spacer/pool). Defaults to true. */
  alwaysMount?: boolean;
}

interface VirtualListState {
  items: HTMLElement[];
  startIndex: number;
  endIndex: number;
  scrollHandler: () => void;
}

export class VirtualList {
  private container: HTMLElement;
  private itemHeight: number;
  private overscan: number;
  private alwaysMount: boolean;
  private spacer: HTMLElement | null = null;
  private pool: HTMLElement | null = null;
  private state: VirtualListState | null = null;

  constructor(options: VirtualListOptions) {
    this.container = options.container;
    this.itemHeight = options.itemHeight;
    this.overscan = options.overscan ?? 2;
    this.alwaysMount = options.alwaysMount ?? true;
    if (this.alwaysMount) return;
    // Windowed mode: spacer + absolute pool inside the container.
    this.spacer = document.createElement('div');
    this.spacer.style.cssText = 'position:relative; width:100%; pointer-events:none;';
    this.container.appendChild(this.spacer);
    this.pool = document.createElement('div');
    this.pool.style.cssText = 'position:absolute; top:0; left:0; right:0;';
    this.spacer.appendChild(this.pool);
  }

  setItems(items: HTMLElement[]): void {
    if (this.alwaysMount) {
      // Soft mode: replace container children with the items.
      // Strip any prior VirtualList DOM first so we don't
      // accumulate leftover nodes across updates.
      if (this.state) {
        for (const it of this.state.items) {
          if (it.parentNode === this.container) it.parentNode.removeChild(it);
        }
      }
      this.state = {
        items,
        startIndex: 0,
        endIndex: items.length,
        scrollHandler: () => undefined,
      };
      const fragment = document.createDocumentFragment();
      for (const it of items) fragment.appendChild(it);
      this.container.appendChild(fragment);
      return;
    }
    if (!this.state) {
      this.state = {
        items,
        startIndex: 0,
        endIndex: 0,
        scrollHandler: () => this.render(),
      };
      this.container.addEventListener('scroll', this.state.scrollHandler, { passive: true });
    } else {
      this.state.items = items;
    }
    if (this.spacer) this.spacer.style.height = `${items.length * this.itemHeight}px`;
    this.render();
  }

  refresh(): void { this.render(); }

  destroy(): void {
    if (this.state && this.state.scrollHandler !== (() => undefined)) {
      this.container.removeEventListener('scroll', this.state.scrollHandler);
    }
    if (this.spacer) this.spacer.remove();
    this.spacer = null;
    this.pool = null;
    this.state = null;
  }

  private render(): void {
    if (!this.state || this.alwaysMount) return;
    const { items } = this.state;
    const containerHeight = this.container.clientHeight;
    const visibleCount = Math.ceil(containerHeight / this.itemHeight);
    const scrollTop = this.container.scrollTop;
    const firstVisible = Math.floor(scrollTop / this.itemHeight);
    const start = Math.max(0, firstVisible - this.overscan);
    const end = Math.min(items.length, firstVisible + visibleCount + this.overscan);
    if (start === this.state.startIndex && end === this.state.endIndex) return;
    this.state.startIndex = start;
    this.state.endIndex = end;
    if (!this.pool) return;
    const fragment = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const node = items[i];
      if (!node) continue;
      node.style.position = 'absolute';
      node.style.top = `${i * this.itemHeight}px`;
      node.style.left = '0';
      node.style.right = '0';
      fragment.appendChild(node);
    }
    this.pool.replaceChildren(fragment);
  }
}
