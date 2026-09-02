// The debug-session lifecycle controller: owns a DebugSession across a debug run, translating UI
// actions (Debug ▸, the step buttons, Stop, the watch / trap-raises toggles, the speed slider)
// into engine directives and pushing state back out through injected callbacks (exec-line
// highlight, status, output, panel render, button-state). DOM-agnostic — the demo (main.ts)
// supplies the callbacks, which is how the Node test drives the whole flow headlessly.
//
// A session starts from *either* Debug ▸ or any step button (stepping from idle enters debug mode
// and pauses at the first statement — no dummy breakpoint needed). A slow "continue" auto-steps
// **over** calls with a per-step dwell, rendering the panels each step — so a slowed run shows
// every user line, and never crawls inside `forward`'s implementation.

import { CanvasSurface } from '@doodle-lang/turtle';
import type { DrawingSurface, FrameSource } from '@doodle-lang/turtle';
import { DebugSession, type DebugDirective, type DebugStop } from './session.js';
import type { DebugPanels } from './panels.js';

/** The debugger's UI state, for enabling/disabling controls. */
export type DebugState = 'idle' | 'running' | 'paused';

/** Turtle animation speed for a debug session (units/frame) — fixed and snappy. The speed slider
 *  controls the per-step **dwell**, not the animation, so `forward` never crawls. */
const DEBUG_TURTLE_SPEED = 40;

export interface DebugDeps {
  /** The current program source. */
  readonly getSource: () => string;
  /** The 1-based editor lines carrying a breakpoint. */
  readonly getBreakpointLines: () => number[];
  /** Whether watch-it-run (fine stops) is enabled. */
  readonly watch: () => boolean;
  /** Whether raise-trapping is enabled. */
  readonly trapRaises: () => boolean;
  /** Per-step dwell (ms) for a slow run; 0 = full speed (a fast continue to the next breakpoint). */
  readonly pace: () => number;
  /** Builds the drawing surface (the demo wires a CanvasSurface; the test a mock). */
  readonly makeSurface: () => DrawingSurface;
  /** The animation clock. */
  readonly frames: FrameSource;
  /** The panels to render at a pause / clear at the end. */
  readonly panels: DebugPanels;
  /** Sets the paused-line highlight (or null to clear); `under` = executing inside that line's call. */
  readonly setExecLine: (line: number | null, under?: boolean) => void;
  /** Sets the status line. */
  readonly setStatus: (text: string, kind?: string) => void;
  /** Appends streamed output. */
  readonly appendOutput: (text: string) => void;
  /** Clears the output pane. */
  readonly clearOutput: () => void;
  /** Notifies the UI of a state change (to toggle buttons). */
  readonly onState: (state: DebugState) => void;
}

/** Drives a debug session through its lifecycle. */
export class DebugController {
  private session: DebugSession | null = null;
  private controller: AbortController | null = null;
  private state: DebugState = 'idle';
  private autostepping = false;

  constructor(private readonly deps: DebugDeps) {}

  /** Whether a debug session is active (running or paused). */
  get active(): boolean {
    return this.session !== null;
  }

  /** A step button: start a session (if needed) — entering debug mode — and drive one directive.
   *  Starting from idle pauses **at** the first user statement (before running it), so no dummy
   *  breakpoint is needed to begin; a subsequent step advances. */
  async step(directive: DebugDirective): Promise<void> {
    if (this.state === 'running') return;
    const status = this.ensureSession();
    if (status === 'error') return;
    if (status === 'created') {
      // Fresh session: pause at the user's first line rather than stepping past it.
      this.handleStop({ kind: 'paused', reason: 'step', line: this.session!.currentLine(), under: false });
      return;
    }
    this.setState('running');
    this.deps.setStatus('debugging…', 'run');
    const stop = await this.driveOnce(directive);
    if (stop) this.handleStop(stop);
  }

  /** Debug ▸ / Continue: start a session (if needed) and run to the next breakpoint / completion
   *  (full speed), or auto-step-over with a per-step dwell showing the panels (slow speed). */
  async continueRun(): Promise<void> {
    if (this.state === 'running') return;
    if (this.ensureSession() === 'error') return;
    if (this.deps.pace() <= 0) {
      this.setState('running');
      this.deps.panels.showRunning();
      this.deps.setStatus('debugging…', 'run');
      const stop = await this.driveOnce('continue');
      if (stop) this.handleStop(stop);
      return;
    }
    await this.autoStep();
  }

  /** Stop: cancel a running drive (→ faulted/cancelled), tear down a paused session, or end an
   *  auto-step. */
  stop(): void {
    this.autostepping = false;
    if (this.state === 'running') this.controller?.abort();
    else if (this.state === 'paused') this.finish({ kind: 'faulted', fault: 'cancelled' });
  }

  /** Forwards a live breakpoint toggle to the engine (no-op if no session). */
  toggleBreakpoint(line: number): void {
    this.session?.toggleBreakpoint(line);
  }

  /** Applies a watch-mode toggle to the live session (takes effect on the next step). */
  setWatch(on: boolean): void {
    this.session?.setWatch(on);
  }

  /** Applies a raise-trap toggle to the live session. */
  setTrapRaises(on: boolean): void {
    this.session?.setRaiseTrap(on);
  }

  // --- internals ---

  /** Ensures a live session, applying the breakpoints + modes and priming past the turtle library
   *  to the user's first line. `'created'` = a fresh session, `'existing'` = one was already
   *  active, `'error'` = the program failed to load. */
  private ensureSession(): 'created' | 'existing' | 'error' {
    if (this.session) return 'existing';
    this.deps.clearOutput();
    this.controller = new AbortController();
    let session: DebugSession;
    try {
      session = new DebugSession(this.deps.getSource(), {
        surface: this.deps.makeSurface(),
        frames: this.deps.frames,
        signal: this.controller.signal,
        onOutput: this.deps.appendOutput,
        speed: DEBUG_TURTLE_SPEED,
      });
    } catch (err) {
      this.deps.setStatus('error', 'error');
      this.deps.appendOutput(String(err instanceof Error ? err.message : err));
      this.controller = null;
      return 'error';
    }
    for (const line of this.deps.getBreakpointLines()) session.toggleBreakpoint(line);
    session.setWatch(this.deps.watch());
    session.setRaiseTrap(this.deps.trapRaises());
    session.primeToUserCode();
    this.session = session;
    return 'created';
  }

  /** Auto-steps **over** statements with a per-step dwell, rendering the panels + line each step,
   *  until a breakpoint / raise-trap / completion / stop. The UI state stays 'running' throughout
   *  so the controls don't flicker; the panels update each step (so a slow run shows the stack and
   *  variables changing). Stepping *over* keeps the pace at user-statement granularity — a
   *  `forward(...)` is one step, its implementation runs at full speed. */
  private async autoStep(): Promise<void> {
    this.autostepping = true;
    this.setState('running');
    this.deps.setStatus('running…', 'run');
    for (;;) {
      const stop = await this.driveOnce('over');
      if (!stop || !this.session) {
        this.autostepping = false;
        return;
      }
      if (stop.kind !== 'paused') {
        this.autostepping = false;
        this.finish(stop);
        return;
      }
      this.renderPaused(stop);
      if (stop.reason !== 'step' || !this.autostepping) {
        // A breakpoint / raise-trap reached mid-run: settle to a real pause.
        this.autostepping = false;
        this.setState('paused');
        this.deps.setStatus(`paused · ${stop.reason}`, 'run');
        return;
      }
      await delay(this.deps.pace());
      if (!this.session || !this.autostepping) {
        this.finish({ kind: 'faulted', fault: 'cancelled' });
        return;
      }
    }
  }

  /** Drives one directive to its stop without touching UI state (the caller manages it). */
  private async driveOnce(directive: DebugDirective): Promise<DebugStop | null> {
    if (!this.session) return null;
    const stop = await this.session.run(directive);
    return this.session ? stop : null; // torn down while driving
  }

  private handleStop(stop: DebugStop): void {
    if (stop.kind === 'paused') {
      this.renderPaused(stop);
      this.setState('paused');
      this.deps.setStatus(`paused · ${stop.reason}`, 'run');
      return;
    }
    this.finish(stop);
  }

  /** Shows the paused line + panels (no state change). */
  private renderPaused(stop: DebugStop & { kind: 'paused' }): void {
    this.deps.setExecLine(stop.line, stop.under);
    this.deps.panels.render(this.session!, stop);
  }

  private finish(stop: DebugStop): void {
    this.deps.setExecLine(null);
    this.deps.panels.clear();
    switch (stop.kind) {
      case 'completed':
        this.deps.setStatus('done', 'ok');
        break;
      case 'faulted':
        this.deps.setStatus(faultLabel(stop.fault), 'warn');
        break;
      case 'raised':
        this.deps.setStatus('error', 'error');
        this.deps.appendOutput(`${stop.exceptionKind}: ${stop.message}\n`);
        break;
      case 'paused':
        break;
    }
    this.session?.free();
    this.session = null;
    this.controller = null;
    this.autostepping = false;
    this.setState('idle');
  }

  private setState(state: DebugState): void {
    this.state = state;
    this.deps.onState(state);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A kid-facing status line for an engine fault (E§10.2). The engine's limits keep a program from
 *  freezing the page; this explains *why* it stopped in plain words rather than a raw fault tag. */
export function faultLabel(fault: string): string {
  switch (fault) {
    case 'cancelled':
      return 'stopped';
    case 'limit:op-result':
    case 'limit:heap':
      return 'stopped — that computation is too big';
    case 'limit:step-budget':
      return 'stopped — that took too long';
    case 'limit:stack-depth':
      return 'stopped — too much nesting';
    default:
      return `stopped — ${fault}`;
  }
}

/** The demo's real drawing-surface factory (a CanvasSurface over the 2D context). */
export function canvasSurfaceFactory(ctx: CanvasRenderingContext2D, width: number, height: number): () => DrawingSurface {
  return () => new CanvasSurface({ ctx, width, height, background: '#ffffff' });
}
