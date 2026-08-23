// The browser entry: mount a CodeMirror editor (with Doodle highlighting), a turtle
// canvas, and Run/Stop buttons wired to the engine via the run core (src/run.ts). Only
// thin DOM glue lives here — the run/pump/turtle wiring is Node-tested in test/run.test.mjs.

import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { doodle } from '@doodle-lang/lezer-doodle';
import { loadEngine } from '@doodle-lang/engine';
import { CanvasSurface } from '@doodle-lang/turtle';

import { runTurtleProgram, type RunResult } from './run.js';

const STARTER = `# A growing spiral — press Run (⌘/Ctrl-Enter). Try changing the numbers!
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

function main(): void {
  const canvas = $('canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d canvas context');
  const output = $('output');
  const status = $('status');
  const runButton = $('run') as HTMLButtonElement;
  const stopButton = $('stop') as HTMLButtonElement;

  const editor = new EditorView({
    parent: $('editor'),
    state: EditorState.create({
      doc: STARTER,
      extensions: [
        lineNumbers(),
        history(),
        highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        doodle(),
        syntaxHighlighting(defaultHighlightStyle),
        keymap.of([{ key: 'Mod-Enter', run: () => (void run(), true) }]),
      ],
    }),
  });

  let controller: AbortController | null = null;

  const setStatus = (text: string, kind = ''): void => {
    status.textContent = text;
    status.dataset['kind'] = kind;
  };

  const showResult = (result: RunResult): void => {
    switch (result.kind) {
      case 'completed':
        setStatus('done', 'ok');
        break;
      case 'faulted':
        setStatus(result.fault === 'cancelled' ? 'stopped' : `stopped: ${result.fault}`, 'warn');
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
    if (controller) return; // already running
    // Create the stop controller up front so a Stop pressed during engine load (or before
    // the first slice) still cancels — `pump` honors an already-aborted signal.
    controller = new AbortController();
    runButton.disabled = true;
    stopButton.disabled = false;
    output.textContent = '';
    setStatus('running…', 'run');
    try {
      await loadEngine(); // idempotent; the browser fetches the co-located wasm
      const surface = new CanvasSurface({
        ctx: ctx!,
        width: canvas.width,
        height: canvas.height,
        background: '#ffffff',
      });
      const result = await runTurtleProgram(editor.state.doc.toString(), {
        surface,
        frames: (cb) => window.requestAnimationFrame(cb),
        signal: controller.signal,
        onOutput: (text) => {
          output.textContent += text;
        },
      });
      showResult(result);
    } catch (err) {
      setStatus('error', 'error');
      output.textContent += String(err instanceof Error ? err.message : err);
    } finally {
      controller = null;
      runButton.disabled = false;
      stopButton.disabled = true;
    }
  }

  runButton.addEventListener('click', () => void run());
  stopButton.addEventListener('click', () => controller?.abort());
  stopButton.disabled = true;
}

main();
