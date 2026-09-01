// The breakpoint gutter for the CodeMirror editor (E§8.6): a clickable gutter that toggles a
// breakpoint dot on a line. It owns the *visual* breakpoint set (1-based editor lines) in a
// StateField; the demo bridges each toggle to the engine (DebugSession.toggleBreakpoint), which
// maps the editor line past the turtle prelude to a module line and sets it on the instance.

import { StateEffect, StateField } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, GutterMarker, gutter } from '@codemirror/view';

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

/** A width-reserving spacer for the gutter (`initialSpacer`) — a dot glyph for sizing, but a
 *  distinct class so it is not mistaken for a real breakpoint (it renders in a hidden measuring
 *  row). */
class SpacerMarker extends GutterMarker {
  override toDOM(): HTMLElement {
    const spacer = document.createElement('span');
    spacer.className = 'cm-breakpoint-spacer';
    spacer.textContent = '●';
    return spacer;
  }
}
const spacer = new SpacerMarker();

/**
 * A clickable breakpoint gutter. `onToggle(line, set)` fires after each toggle with the
 * 1-based editor line and whether it is now set — the demo forwards it to the engine.
 */
export function breakpointGutter(onToggle: (line: number, set: boolean) => void): Extension {
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
      domEventHandlers: {
        mousedown(view, line) {
          const lineNumber = view.state.doc.lineAt(line.from).number;
          const wasSet = view.state.field(breakpointState).has(lineNumber);
          view.dispatch({ effects: toggleEffect.of(lineNumber) });
          onToggle(lineNumber, !wasSet);
          return true;
        },
      },
    }),
  ];
}

/** The 1-based editor lines currently carrying a breakpoint. */
export function breakpointLines(view: EditorView): number[] {
  return [...view.state.field(breakpointState)];
}
