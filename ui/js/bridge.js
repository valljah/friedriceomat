// Optional WebSocket bridge to the physical robot.
//
// Outgoing:  { type: 'plan', plan }
//            { type: 'command', action, durationSec, burner, stage, params }
// Incoming:  { type: 'telemetry', sensors: { temp, moisture, browning, clump, mix, smoke, mass } }
//            { type: 'log', message }
//
// When "use robot sensors" is on, incoming telemetry replaces the simulated
// readings the policy acts on; the simulator keeps driving the animation.

export class RobotBridge extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.latest = null;
    this.latestAt = 0;
  }

  get connected() { return this.ws?.readyState === WebSocket.OPEN; }

  connect(url) {
    this.disconnect();
    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.emit('status', { state: 'error', message: err.message });
      return;
    }
    this.emit('status', { state: 'connecting' });
    this.ws.addEventListener('open', () => this.emit('status', { state: 'open' }));
    this.ws.addEventListener('close', () => this.emit('status', { state: 'closed' }));
    this.ws.addEventListener('error', () => this.emit('status', { state: 'error', message: 'connection failed' }));
    this.ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'telemetry' && msg.sensors) {
        this.latest = msg.sensors;
        this.latestAt = performance.now();
      }
      this.emit('message', msg);
    });
  }

  disconnect() {
    if (this.ws) this.ws.close();
    this.ws = null;
    this.latest = null;
  }

  // Robot readings no older than `maxAgeMs`, else null.
  fresh(maxAgeMs = 2000) {
    return this.latest && performance.now() - this.latestAt < maxAgeMs ? this.latest : null;
  }

  send(msg) {
    if (this.connected) this.ws.send(JSON.stringify(msg));
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}
