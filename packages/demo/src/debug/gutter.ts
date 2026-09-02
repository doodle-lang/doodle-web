// The breakpoint gutter for the CodeMirror editor (E§8.6): a clickable dot column *and*
// clickable line numbers (a bigger target), which toggle a breakpoint on the nearest **code**
// line at or after the click — so a click on a blank or comment line lands the dot on the
// statement where it will actually break, and you can't arm an unhittable mark. It owns the
// *visual* breakpoint set (1-based editor lines) in a StateField; the demo bridges each toggle to
// the engine (DebugSession.toggleBreakpoint), which maps the editor line past the turtle prelude.

import { StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Extension } from '@codemirror/state';
import { EditorView, GutterMarker, gutter, lineNumbers } from '@codemirror/view';
import type { BlockInfo } from '@codemirror/view';

/** Toggles the breakpoint on a 1-based editor line. */
const toggleEffect = StateEffect.define<number>();

/** The set of 1-based editor lines that carry a breakpoint. */
const breakpointState = StateField.define<Set<number>>({
  create: () => new Set(),
  update(set, tr) {
    let next = set;
    for (const effect of tr.effects) {
      if (effect.is(toggleEffect)) {
        next = new Set(next);
        if (next.has(effect.value)) next.delete(effect.value);
        else next.add(effect.value);
      }
    }
    return next;
  },
});

/** The breakpoint dot rendered in the gutter on a breakpointed line. */
class BreakpointMarker extends GutterMarker {
  override toDOM(): HTMLElement {
    const dot = document.createElement('span');
    dot.className = 'cm-breakpoint-dot';
    dot.textContent = '●';
    return dot;
  }
}
const marker = new BreakpointMarker();

/** A width-reserving spacer for the dot gutter — a distinct class so it is not mistaken for a
 *  real breakpoint (it renders in a hidden measuring row). */
class SpacerMarker extends GutterMarker {
  override toDOM(): HTMLElement {
    const spacer = document.createElement('span');
    spacer.className = 'cm-breakpoint-spacer';
    spacer.textContent = '●';
    return spacer;
  }
}
const spacer = new SpacerMarker();

/** The nearest **code** line at or after 1-based `lineNumber` (non-blank, not a `#` comment), or
 *  null if there is none — where a breakpoint clicked at `lineNumber` actually belongs. */
function codeLineAt(state: EditorState, lineNumber: number): number | null {
  for (let n = lineNumber; n <= state.doc.lines; n += 1) {
    const text = state.doc.line(n).text.trim();
    if (text !== '' && !text.startsWith('#')) return n;
  }
  return null;
}

/**
 * A clickable breakpoint gutter: a dot column plus clickable line numbers. `onToggle(line, set)`
 * fires after each toggle with the 1-based editor line (snapped to a code line) and whether it is
 * now set — the demo forwards it to the engine.
 */
export function breakpointGutter(onToggle: (line: number, set: boolean) => void): Extension {
  const toggle = (view: EditorView, block: BlockInfo): boolean => {
    const clicked = view.state.doc.lineAt(block.from).number;
    const line = codeLineAt(view.state, clicked);
    if (line === null) return true; // clicked past the last statement — nothing to break on
    const wasSet = view.state.field(breakpointState).has(line);
    view.dispatch({ effects: toggleEffect.of(line) });
    onToggle(line, !wasSet);
    return true;
  };
  return [
    breakpointState,
    gutter({
      class: 'cm-breakpoint-gutter',
      lineMarker: (view, line) =>
        view.state.field(breakpointState).has(view.state.doc.lineAt(line.from).number) ? marker : null,
      // Recompute markers when the breakpoint set changes (a state-only transaction has no doc
      // change, so the gutter would otherwise not re-render the dot after a toggle).
      lineMarkerChange: (update) =>
        update.startState.field(breakpointState) !== update.state.field(breakpointState),
      initialSpacer: () => spacer,
      domEventHandlers: { mousedown: toggle },
    }),
    // Line numbers are a breakpoint target too (a bigger, easier-to-hit area than the dot column).
    lineNumbers({ domEventHandlers: { mousedown: toggle } }),
  ];
}

/** The 1-based editor lines currently carrying a breakpoint. */
export function breakpointLines(view: EditorView): number[] {
  return [...view.state.field(breakpointState)];
}
