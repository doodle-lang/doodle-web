// The debugger's panels (E§8): renders, from a paused DebugSession, the call stack (with
// tail-iteration badges and tail-elided history), the selected frame's Variables (locals,
// `with` dynamic bindings, and the module's globals — each an expandable value tree), a
// raise-trap readout (the raised value at a pre-unwind stop), and the watch-it-run value (the
// just-produced subexpression value at a fine stop). All value handles minted for a render are
// released within it (see inspect.ts), so the DOM holds no live handles.

import { stackWalk, moduleGlobals } from '@doodle-lang/engine';
import type { DoodleInstance, StackFrame, GlobalBinding } from '@doodle-lang/engine';
import { materializeValue, type ValueNode } from './inspect.js';
import type { DebugSession, DebugStop } from './session.js';

/** The module-global kinds shown as *variables* (E§8.2); the rest are the module's other
 *  declarations (to/fn/record/…), hidden from the panel. */
const VARIABLE_KINDS = new Set(['let', 'const', 'parameter']);

/** Owns the debug-panels DOM and the selected-frame state, re-rendering on each pause. */
export class DebugPanels {
  private selectedFrame = 0;
  private current: { session: DebugSession; stop: DebugStop } | null = null;

  constructor(private readonly container: HTMLElement) {}

  /** Clears the panels (a session ended / not stopped). */
  clear(): void {
    this.container.replaceChildren();
    this.selectedFrame = 0;
    this.current = null;
  }

  /** Shows a placeholder while a drive is in flight (there is no stable state to inspect), so the
   *  panels region stays present and stably sized across the pause/run cycle. */
  showRunning(): void {
    this.current = null;
    this.container.replaceChildren(section('Debugger', [muted('running… (pauses at a breakpoint or step)')]));
  }

  /** Re-renders the panels from the session's current paused state. `stop` is the pause that
   *  produced it (its reason drives the raise-trap readout). Reset the frame selection when a
   *  new pause arrives (a different `stop` object), keep it on a same-pause re-render (a frame
   *  click). */
  render(session: DebugSession, stop: DebugStop): void {
    if (!this.current || this.current.stop !== stop) this.selectedFrame = 0;
    this.current = { session, stop };
    const inst = session.instance;
    const walk = stackWalk(inst);
    const live = walk.frames.filter((f) => !f.elided);
    if (this.selectedFrame >= live.length) this.selectedFrame = 0;

    const panels: HTMLElement[] = [];
    panels.push(this.renderCallStack(session, walk.frames, live.length));
    panels.push(this.renderVariables(session, walk.generation, live[this.selectedFrame]));
    if (stop.kind === 'paused' && stop.reason === 'raise-trap') {
      panels.push(this.renderRaiseTrap(inst));
    }
    const watch = watchValue(inst);
    if (watch) panels.push(section('Watch', [watch]));
    this.container.replaceChildren(...panels);
  }

  private renderCallStack(session: DebugSession, frames: readonly StackFrame[], liveCount: number): HTMLElement {
    const rows: HTMLElement[] = [];
    let liveIndex = 0;
    for (const frame of frames) {
      if (frame.elided) {
        rows.push(el('li', { class: 'frame elided' }, frameLabel(frame), tag('tail-elided')));
        continue;
      }
      const index = liveIndex;
      liveIndex += 1;
      const row = el('li', { class: 'frame' + (index === this.selectedFrame ? ' selected' : '') }, frameLabel(frame));
      const line = frame.callSite ? session.userLineOf(frame.callSite) : null;
      if (line !== null) row.appendChild(muted(`line ${line}`));
      if (frame.tailCount > 0) row.appendChild(tag(`×${frame.tailCount}`));
      if (liveCount > 1) {
        row.classList.add('clickable');
        row.addEventListener('click', () => {
          if (this.selectedFrame === index || !this.current) return;
          this.selectedFrame = index;
          // Re-render the panels for the newly selected frame — no drive happened, so the pause
          // generation is still valid and the walk is unchanged.
          this.render(this.current.session, this.current.stop);
        });
      }
      rows.push(row);
    }
    return section('Call stack', [el('ul', { class: 'stack' }, ...rows)]);
  }

  private renderVariables(session: DebugSession, generation: number, frame: StackFrame | undefined): HTMLElement {
    if (!frame) return section('Variables', [muted('no frame')]);
    const inst = session.instance;
    const groups: HTMLElement[] = [];

    const locals = frame.locals.map((name, slot) =>
      binding(inst, name, tryHandle(() => inst.frameLocal(generation, this.selectedFrame, slot))),
    );
    if (locals.length) groups.push(varGroup('Locals', locals));

    const dynamics = frame.dynamics.map((name, slot) =>
      binding(inst, name, tryHandle(() => inst.frameDynamic(generation, this.selectedFrame, slot))),
    );
    if (dynamics.length) groups.push(varGroup('with (dynamic)', dynamics));

    if (frame.module !== undefined) {
      const module = frame.module;
      const bindingFor = (g: GlobalBinding): HTMLElement =>
        binding(inst, g.name, tryHandle(() => inst.moduleGlobalValue(generation, module, g.slot)), g.kind);
      const variables = moduleGlobals(inst, module).filter((g) => VARIABLE_KINDS.has(g.kind));
      // Separate the program's own top-level globals from a prepended library's (the turtle
      // demo prepends its library into the entry module): a library global's declaration
      // precedes the user program, so `userLineOf` maps it to null. Show the user's globals
      // prominently; tuck the library's into a collapsed group so they don't crowd them out.
      const mine = variables.filter((g) => session.userLineOf(g.declSpan) !== null);
      const library = variables.filter((g) => session.userLineOf(g.declSpan) === null);
      if (mine.length) groups.push(varGroup('Module globals', mine.map(bindingFor)));
      if (library.length) groups.push(collapsedGroup(`Library globals (${library.length})`, library.map(bindingFor)));
    }

    if (!groups.length) groups.push(muted('no variables in scope'));
    return section('Variables', groups);
  }

  private renderRaiseTrap(inst: DoodleInstance): HTMLElement {
    const handle = inst.trappedRaise();
    const body: HTMLElement[] = [
      muted('paused at the raise — the stack above is intact (pre-unwind); resume to propagate'),
    ];
    if (handle !== undefined) {
      body.push(binding(inst, 'raised', handle));
    }
    return section('Trapped raise', body);
  }
}

/** A frame's display label: its callable name + kind (or `(module)` / `(block)`), and call line. */
function frameLabel(frame: StackFrame): HTMLElement {
  const callable = frame.callable;
  let text: string;
  if (!callable) {
    text = frame.callSite ? '(block)' : '(module)';
  } else {
    const keyword = callable.isFunction === undefined ? '' : callable.isFunction ? 'fn ' : 'to ';
    text = `${keyword}${callable.name ?? '‹anonymous›'}`;
  }
  return el('span', { class: 'frame-name' }, text);
}

/** A `name = value-tree` binding row, releasing the minted value handle after materializing. A
 *  `undefined` handle is a not-yet-defined slot (TDZ). */
function binding(inst: DoodleInstance, name: string, handle: bigint | undefined, kind?: string): HTMLElement {
  const row = el('div', { class: 'binding' }, el('span', { class: 'bind-name' }, name));
  if (kind) row.appendChild(el('span', { class: 'bind-kind' }, kind));
  if (handle === undefined) {
    row.appendChild(el('span', { class: 'bind-tdz' }, '‹not yet defined›'));
    return row;
  }
  const node = materializeValue(inst, handle);
  inst.release(handle);
  row.appendChild(renderNode(node));
  return row;
}

/** Renders a materialized {@link ValueNode}: a leaf as a coloured span, a compound as a
 *  collapsible `<details>` whose children are nested binding rows. */
function renderNode(node: ValueNode): HTMLElement {
  if (node.children.length === 0) {
    const span = el('span', { class: `val val-${node.kind}` }, node.summary);
    if (node.truncated) span.appendChild(tag('…'));
    return span;
  }
  const details = el('details', { class: 'val-tree' });
  const summary = el('summary', { class: `val val-${node.kind}` }, node.summary);
  details.appendChild(summary);
  const list = el('div', { class: 'val-children' });
  for (const child of node.children) {
    const childRow = el('div', { class: 'binding' }, el('span', { class: 'bind-name' }, child.label));
    childRow.appendChild(renderNode(child.value));
    list.appendChild(childRow);
  }
  if (node.truncated) list.appendChild(muted('… (truncated)'));
  details.appendChild(list);
  return details;
}

/** The watch-it-run readout: the just-produced value at a fine stop, or null when not at one. */
function watchValue(inst: DoodleInstance): HTMLElement | null {
  if (!inst.completedSpan()) return null;
  const handle = inst.currentResult();
  if (handle === undefined) return muted('(void)');
  const node = materializeValue(inst, handle);
  inst.release(handle);
  const row = el('div', { class: 'binding' }, el('span', { class: 'bind-name' }, '⟳'));
  row.appendChild(renderNode(node));
  return row;
}

// --- small DOM helpers ---

function section(title: string, body: HTMLElement[]): HTMLElement {
  return el('section', { class: 'debug-section' }, el('h3', {}, title), ...body);
}

function varGroup(title: string, rows: HTMLElement[]): HTMLElement {
  return el('div', { class: 'var-group' }, el('h4', {}, title), ...rows);
}

/** A collapsed-by-default variable group (for the prepended library's globals). */
function collapsedGroup(title: string, rows: HTMLElement[]): HTMLElement {
  const details = el('details', { class: 'var-group' });
  details.appendChild(el('summary', { class: 'var-group-summary' }, title));
  for (const row of rows) details.appendChild(row);
  return details;
}

function tag(text: string): HTMLElement {
  return el('span', { class: 'badge' }, text);
}

function muted(text: string): HTMLElement {
  return el('div', { class: 'muted' }, text);
}

/** Reads a value handle, mapping a throw (a stale generation, e.g.) to `undefined`. */
function tryHandle(read: () => bigint | undefined): bigint | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

type Props = Record<string, string>;
function el(tagName: string, props: Props = {}, ...children: (HTMLElement | string)[]): HTMLElement {
  const node = document.createElement(tagName);
  for (const [k, v] of Object.entries(props)) node.setAttribute(k, v);
  for (const child of children) node.append(child);
  return node;
}
