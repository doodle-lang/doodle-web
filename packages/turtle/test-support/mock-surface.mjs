// A recording `DrawingSurface` for headless tests: captures the ordered
// begin/marker/end/clear calls so a test can assert the committed path and the marker
// poses without a real canvas. `committed` mirrors what a `CanvasSurface` would keep on
// screen (a `clear` empties it); `events` is the full ordered log for finer assertions.

export class MockSurface {
  constructor() {
    this.events = [];
    this.committed = []; // segments finished with endStroke(true), minus any cleared
    this.discarded = 0; // count of endStroke(false) — interrupted forwards
    this.markers = []; // every marker pose, in order
    this.clears = 0;
    this._stroke = null;
  }

  beginStroke(seg) {
    this._stroke = seg;
    this.events.push({ type: 'begin', seg });
  }

  setMarker(marker) {
    this.markers.push(marker);
    this.events.push({ type: 'marker', marker });
  }

  endStroke(commit) {
    if (commit) {
      if (this._stroke) this.committed.push(this._stroke);
    } else {
      this.discarded += 1;
    }
    this.events.push({ type: 'end', commit });
    this._stroke = null;
  }

  clear() {
    this.clears += 1;
    this.committed.length = 0;
    this.events.push({ type: 'clear' });
  }

  /** The most recent marker pose, or null if none. */
  lastMarker() {
    return this.markers.length > 0 ? this.markers[this.markers.length - 1] : null;
  }
}
