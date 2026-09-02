// The browser entry: mount a CodeMirror editor (Doodle highlighting + a breakpoint gutter), a
// turtle canvas, and the Run / Debug / Stop controls. Run animates a program to completion (the
// run core, src/run.ts); Debug drives it under the engine's observation surface (the debug
// controller, src/debug/) — breakpoints, stepping, and the call-stack / variables / value-tree /
// raise-trap panels. Only thin DOM glue lives here; the run and debug cores are Node-tested.

import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine, Decoration } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { doodle } from '@doodle-lang/lezer-doodle';
import { loadEngine } from '@doodle-lang/engine';

import { runTurtleProgram, type RunResult } from './run.js';
import { breakpointGutter, breakpointLines } from './debug/gutter.js';
import { DebugPanels } from './debug/panels.js';
import { DebugController, canvasSurfaceFactory, faultLabel, type DebugState } from './debug/controller.js';
import type { DebugDirective } from './debug/session.js';

const STARTER = `# A growing spiral — Run (⌘/Ctrl-Enter) to animate, or Debug to step through.
# Click the gutter (left of a line) to set a breakpoint ●, then press Debug.
pencolor("blue")
let side = 5
let n = 0
while n < 60 do
  forward(side)
  right(24)
  side = side + 2
  n = n + 1
end
print("done")
`;

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

// A line decoration that follows execution — set by `setExecLine` with a 1-based user-program
// line (or null to clear) and an `under` flag: `under` means execution is *inside* a call from
// that line (a library/procedure whose source is not shown), coloured differently so a step into
// `forward` reads as "running under this line", not "stopped on it". Driven by the run core's
// `onLine` and the debugger's paused line.
const setExecLine = StateEffect.define<{ line: number | null; under: boolean }>();
const execLineMark = Decoration.line({ class: 'cm-execLine' });
const execUnderMark = Decoration.line({ class: 'cm-execLine cm-execLine-under' });
const execLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setExecLine)) {
        const { line, under } = effect.value;
        next =
          line !== null && line >= 1 && line <= tr.state.doc.lines
            ? Decoration.set([(under ? execUnderMark : execLineMark).range(tr.state.doc.line(line).from)])
            : Decoration.none;
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function main(): void {
  const canvas = $('canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d canvas context');
  const makeSurface = canvasSurfaceFactory(ctx, canvas.width, canvas.height);
  const output = $('output');
  const status = $('status');
  const runButton = $('run') as HTMLButtonElement;
  const debugButton = $('debug') as HTMLButtonElement;
  const stopButton = $('stop') as HTMLButtonElement;
  const watchBox = $('watch') as HTMLInputElement;
  const trapBox = $('trap') as HTMLInputElement;
  const speedSlider = $('speed') as HTMLInputElement;
  // The slider (1 = slow … 5 = fast) sets the per-step dwell of a slow run. At 5 (fast) the dwell
  // is 0 and Continue runs to the next breakpoint; below 5, a run auto-steps *over* calls with the
  // dwell, showing the panels + line each step (so every user line is visible, not just drawing).
  const paceMs = (): number =>
    Number(speedSlider.value) >= 5 ? 0 : (5 - Number(speedSlider.value)) * 120;
  const continueButton = $('continue') as HTMLButtonElement;
  // The step buttons: the primary "Step" is step-over (the everyday one); "Into" descends into a
  // call, "Out" runs to the end of the current call.
  const stepActions: [HTMLButtonElement, DebugDirective][] = [
    [$('step') as HTMLButtonElement, 'over'],
    [$('into') as HTMLButtonElement, 'into'],
    [$('out') as HTMLButtonElement, 'out'],
  ];
  const debugButtons = [continueButton, ...stepActions.map(([button]) => button)];

  const setExec = (line: number | null, under = false): void =>
    editor.dispatch({ effects: setExecLine.of({ line, under }) });

  const editor = new EditorView({
    parent: $('editor'),
    state: EditorState.create({
      doc: STARTER,
      extensions: [
        breakpointGutter((line) => debug.toggleBreakpoint(line)),
        history(),
        highlightActiveLine(),
        execLineField,
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        doodle(),
        syntaxHighlighting(defaultHighlightStyle),
        keymap.of([{ key: 'Mod-Enter', run: () => (void run(), true) }]),
      ],
    }),
  });

  const panels = new DebugPanels($('debug-panels'));

  const setStatus = (text: string, kind = ''): void => {
    status.textContent = text;
    status.dataset['kind'] = kind;
  };

  // --- Debug ---

  let runController: AbortController | null = null;
  let debugState: DebugState = 'idle';

  const refreshButtons = (): void => {
    const runActive = runController !== null;
    const sessionActive = debugState !== 'idle';
    runButton.disabled = runActive || sessionActive;
    debugButton.disabled = runActive || sessionActive;
    stopButton.disabled = !(runActive || sessionActive);
    // Panels show for the whole debug session (running and paused); the debug bar is always
    // present, so the step buttons can *start* a session from idle.
    $('debug-panels').hidden = !sessionActive;
    // Step controls are usable when idle (they enter debug mode) or paused; disabled mid-drive.
    const stepUsable = !runActive && debugState !== 'running';
    for (const button of debugButtons) button.disabled = !stepUsable;
  };

  const debug = new DebugController({
    getSource: () => editor.state.doc.toString(),
    getBreakpointLines: () => breakpointLines(editor),
    watch: () => watchBox.checked,
    trapRaises: () => trapBox.checked,
    pace: paceMs,
    makeSurface,
    frames: (cb) => window.requestAnimationFrame(cb),
    panels,
    setExecLine: setExec,
    setStatus,
    appendOutput: (text) => {
      output.textContent += text;
    },
    clearOutput: () => {
      output.textContent = '';
    },
    onState: (state) => {
      debugState = state;
      refreshButtons();
    },
  });

  // Every debug action may create a session (which needs the wasm loaded first).
  const withEngine = async (action: () => Promise<void>): Promise<void> => {
    if (runController) return;
    try {
      await loadEngine();
      await action();
    } catch (err) {
      setStatus('error', 'error');
      output.textContent += String(err instanceof Error ? err.message : err);
    }
  };

  debugButton.addEventListener('click', () => void withEngine(() => debug.continueRun()));
  continueButton.addEventListener('click', () => void withEngine(() => debug.continueRun()));
  for (const [button, directive] of stepActions) {
    button.addEventListener('click', () => void withEngine(() => debug.step(directive)));
  }
  watchBox.addEventListener('change', () => debug.setWatch(watchBox.checked));
  trapBox.addEventListener('change', () => debug.setTrapRaises(trapBox.checked));

  // --- Run (animate to completion) ---

  const showResult = (result: RunResult): void => {
    switch (result.kind) {
      case 'completed':
        setStatus('done', 'ok');
        break;
      case 'faulted':
        setStatus(faultLabel(result.fault), 'warn');
        break;
      case 'raised':
        setStatus('error', 'error');
        output.textContent += `${output.textContent ? '\n' : ''}${result.exceptionKind}: ${result.message}`;
        break;
      case 'load-error':
        setStatus('error', 'error');
        output.textContent += `${output.textContent ? '\n' : ''}${result.message}`;
        break;
    }
  };

  async function run(): Promise<void> {
    if (runController || debug.active) return;
    runController = new AbortController();
    refreshButtons();
    output.textContent = '';
    setStatus('running…', 'run');
    try {
      await loadEngine();
      const surface = makeSurface();
      const result = await runTurtleProgram(editor.state.doc.toString(), {
        surface,
        frames: (cb) => window.requestAnimationFrame(cb),
        signal: runController.signal,
        onOutput: (text) => {
          output.textContent += text;
        },
        onLine: (line) => setExec(line),
      });
      showResult(result);
    } catch (err) {
      setStatus('error', 'error');
      output.textContent += String(err instanceof Error ? err.message : err);
    } finally {
      setExec(null);
      runController = null;
      refreshButtons();
    }
  }

  runButton.addEventListener('click', () => void run());
  stopButton.addEventListener('click', () => {
    runController?.abort();
    debug.stop();
  });
  refreshButtons();
}

main();
