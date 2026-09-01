// The debug-session lifecycle controller: owns a DebugSession across a debug run, translating
// UI actions (Debug ▸, the step buttons, the watch / trap-raises toggles, Stop) into engine
// directives and pushing state back out through injected callbacks (exec-line highlight, status,
// output, panel render, button-state). DOM-agnostic — the demo (main.ts) supplies the callbacks,
// which is how the Node test drives the whole flow headlessly with a mock surface.

import { CanvasSurface } from '@doodle-lang/turtle';
import type { DrawingSurface, FrameSource } from '@doodle-lang/turtle';
import { DebugSession, type DebugDirective, type DebugStop } from './session.js';
import type { DebugPanels } from './panels.js';

/** The debugger's UI state, for enabling/disabling controls. */
export type DebugState = 'idle' | 'running' | 'paused';

export interface DebugDeps {
  /** The current program source. */
  readonly getSource: () => string;
  /** The 1-based editor lines carrying a breakpoint. */
  readonly getBreakpointLines: () => number[];
  /** Whether watch-it-run (fine stops) is enabled. */
  readonly watch: () => boolean;
  /** Whether raise-trapping is enabled. */
  readonly trapRaises: () => boolean;
  /** Builds the drawing surface (the demo wires a CanvasSurface; the test a mock). */
  readonly makeSurface: () => DrawingSurface;
  /** The animation clock. */
  readonly frames: FrameSource;
  /** The panels to render at a pause / clear at the end. */
  readonly panels: DebugPanels;
  /** Sets the paused-line highlight (or null to clear). */
  readonly setExecLine: (line: number | null) => void;
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

  constructor(private readonly deps: DebugDeps) {}

  /** Whether a debug session is active (running or paused). */
  get active(): boolean {
    return this.session !== null;
  }

  /** Starts a debug session: loads the program, applies breakpoints + modes, and runs to the
   *  first stop (a breakpoint, or completion if none). A load error ends the session. */
  async start(): Promise<void> {
    if (this.session) return;
    this.deps.clearOutput();
    this.controller = new AbortController();
    let session: DebugSession;
    try {
      session = new DebugSession(this.deps.getSource(), {
        surface: this.deps.makeSurface(),
        frames: this.deps.frames,
        signal: this.controller.signal,
        onOutput: this.deps.appendOutput,
        speed: 40,
      });
    } catch (err) {
      this.deps.setStatus('error', 'error');
      this.deps.appendOutput(String(err instanceof Error ? err.message : err));
      this.controller = null;
      return;
    }
    this.session = session;
    for (const line of this.deps.getBreakpointLines()) session.toggleBreakpoint(line);
    session.setWatch(this.deps.watch());
    session.setRaiseTrap(this.deps.trapRaises());
    await this.driveTo('continue');
  }

  /** Drives one directive (from a step button) to the next stop. Valid only while paused. */
  async step(directive: DebugDirective): Promise<void> {
    if (!this.session || this.state !== 'paused') return;
    await this.driveTo(directive);
  }

  /** Stop: cancels a running drive (→ faulted/cancelled), or tears down a paused session. */
  stop(): void {
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

  private async driveTo(directive: DebugDirective): Promise<void> {
    if (!this.session) return;
    this.setState('running');
    this.deps.setStatus('debugging…', 'run');
    const stop = await this.session.run(directive);
    if (!this.session) return; // torn down while driving
    this.handleStop(stop);
  }

  private handleStop(stop: DebugStop): void {
    if (stop.kind === 'paused') {
      this.deps.setExecLine(stop.line);
      this.deps.panels.render(this.session!, stop);
      this.setState('paused');
      this.deps.setStatus(`paused · ${stop.reason}`, 'run');
      return;
    }
    this.finish(stop);
  }

  private finish(stop: DebugStop): void {
    this.deps.setExecLine(null);
    this.deps.panels.clear();
    switch (stop.kind) {
      case 'completed':
        this.deps.setStatus('done', 'ok');
        break;
      case 'faulted':
        this.deps.setStatus(stop.fault === 'cancelled' ? 'stopped' : `stopped · ${stop.fault}`, 'warn');
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
    this.setState('idle');
  }

  private setState(state: DebugState): void {
    this.state = state;
    this.deps.onState(state);
  }
}

/** The demo's real drawing-surface factory (a CanvasSurface over the 2D context). */
export function canvasSurfaceFactory(ctx: CanvasRenderingContext2D, width: number, height: number): () => DrawingSurface {
  return () => new CanvasSurface({ ctx, width, height, background: '#ffffff' });
}
