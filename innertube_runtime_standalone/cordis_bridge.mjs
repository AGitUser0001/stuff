/** Cordis Bridge protocol peer shared by the InnerTube worker and browser. */

const PROTOCOL = 1;

export class CordisBridge {
  /** @param {any} ctx @param {{send: (frame: any) => void, listen: (frame: (value: any) => void, closed: () => void) => () => void, close: () => void}} transport @param {string} name */
  constructor(ctx, transport, name) {
    this.ctx = ctx;
    this.transport = transport;
    this.name = name;
    this.closed = false;
    this.connected = false;
    this.nextId = 0;
    /** @type {Map<string, {resolve: (value: any) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout>}>} */
    this.pending = new Map();
    /** @type {Map<string, any>} */ this.services = new Map();
    /** @type {Map<string, Set<(...args: any[]) => void>>} */ this.listeners = new Map();
    /** @type {(value: void) => void} */ this.resolveReady = () => {};
    /** @type {(reason: Error) => void} */ this.rejectReady = () => {};
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.ready.catch(() => {});
    this.unlisten = transport.listen(frame => this.receive(frame), () => this.close());
    this.handshakeTimer = setTimeout(() => this.close(new Error('Bridge handshake timed out')), 5000);
    transport.send({ type: 'hello', protocol: PROTOCOL, name });
    ctx.effect(() => () => this.close());
  }

  /** @param {string} name @param {object | Function} service */
  expose(name, service) {
    if (this.services.has(name)) throw new Error(`Bridge service already exposed: ${name}`);
    this.services.set(name, service);
    const dispose = () => { if (this.services.get(name) === service) this.services.delete(name); };
    this.ctx.effect(() => dispose);
    return dispose;
  }

  /** @param {string} name @param {string | null} method @param {any[]} args @param {Record<string, any>} [kwargs] */
  async call(name, method, args, kwargs = {}) {
    await this.ready;
    if (this.closed) throw new Error('Bridge is closed');
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Bridge call timed out')); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.transport.send({ type: 'call', id, name, method, args, kwargs }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  /** @param {string} event @param {...any} args */
  sendEvent(event, ...args) {
    if (!this.closed) this.transport.send({ type: 'event', event, args });
  }

  /** @param {string} event @param {(...args: any[]) => void} listener */
  onEvent(event, listener) {
    const listeners = this.listeners.get(event) || new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    const dispose = () => listeners.delete(listener);
    this.ctx.effect(() => dispose);
    return dispose;
  }

  /** @param {any} frame */
  receive(frame) {
    if (this.closed || !frame || typeof frame !== 'object') return;
    if (frame.type === 'hello') {
      if (frame.protocol !== PROTOCOL) { this.close(new Error('Bridge protocol mismatch')); return; }
      if (!this.connected) {
        this.connected = true;
        clearTimeout(this.handshakeTimer);
        this.resolveReady();
      }
      return;
    }
    if (!this.connected) { this.close(new Error('Bridge peer did not say hello')); return; }
    if (frame.type === 'call') { void this.dispatchCall(frame); return; }
    if (frame.type === 'result' || frame.type === 'error') {
      const pending = this.pending.get(String(frame.id));
      if (!pending) return;
      this.pending.delete(String(frame.id));
      clearTimeout(pending.timer);
      if (frame.type === 'error') pending.reject(new Error(String(frame.message || 'remote call failed')));
      else pending.resolve(frame.value);
      return;
    }
    if (frame.type === 'event') {
      const event = String(frame.event || '');
      const args = Array.isArray(frame.args) ? frame.args : [];
      for (const listener of this.listeners.get(event) || []) listener(...args);
      this.ctx.emit('bridge/event', event, ...args);
    }
    if (frame.type === 'bye') this.close();
  }

  /** @param {any} frame */
  async dispatchCall(frame) {
    try {
      const service = this.services.get(String(frame.name || ''));
      if (!service) throw new Error('service is not exposed');
      const method = frame.method;
      if (method !== null && (typeof method !== 'string' || method.startsWith('_'))) throw new Error('method is not exposed');
      const target = method === null ? service : Object.prototype.hasOwnProperty.call(service, method) ? service[method] : null;
      if (typeof target !== 'function') throw new Error('method is not exposed');
      const args = Array.isArray(frame.args) ? frame.args : [];
      if (frame.kwargs && Object.keys(frame.kwargs).length) throw new Error('keyword arguments are not supported');
      const value = await target.apply(service, args);
      this.transport.send({ type: 'result', id: frame.id, value });
    } catch (error) {
      this.transport.send({ type: 'error', id: frame.id, name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** @param {Error} [error] */
  close(error = new Error('Bridge closed')) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.handshakeTimer);
    if (!this.connected) this.rejectReady(error);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.unlisten();
    this.transport.close();
  }
}

/** @param {WebSocket} socket */
export function webSocketTransport(socket) {
  return {
    /** @param {any} frame */
    send: frame => socket.send(JSON.stringify(frame)),
    /** @param {(frame: any) => void} onFrame @param {() => void} onClose */
    listen(onFrame, onClose) {
      /** @param {MessageEvent} event */
      const message = event => {
        try { onFrame(JSON.parse(event.data)); } catch { socket.close(); }
      };
      socket.addEventListener('message', message);
      socket.addEventListener('close', onClose);
      return () => { socket.removeEventListener('message', message); socket.removeEventListener('close', onClose); };
    },
    close: () => socket.close(),
  };
}

/** @param {{on: (name: string, listener: (...args: any[]) => void) => void, off: (name: string, listener: (...args: any[]) => void) => void}} input @param {{write: (text: string) => void}} output */
export function lineTransport(input, output) {
  return {
    /** @param {any} frame */
    send: frame => output.write(`${JSON.stringify(frame)}\n`),
    /** @param {(frame: any) => void} onFrame @param {() => void} onClose */
    listen(onFrame, onClose) {
      /** @param {string} text */
      const line = text => {
        try { onFrame(JSON.parse(text)); } catch { /* malformed peer frame */ }
      };
      input.on('line', line);
      input.on('close', onClose);
      return () => { input.off('line', line); input.off('close', onClose); };
    },
    close: () => {},
  };
}
