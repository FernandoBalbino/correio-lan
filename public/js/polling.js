export class PollingManager {
  constructor({ onError = () => {}, onSuccess = () => {} } = {}) {
    this.tasks = new Map(); this.active = false; this.generation = 0; this.onError = onError; this.onSuccess = onSuccess;
  }
  add(name, interval, run) { this.tasks.set(name, { interval, run, timer: null, controller: null, failures: 0 }); return this; }
  start() { if (this.active) return; this.active = true; this.generation++; for (const name of this.tasks.keys()) this.trigger(name); }
  stop() {
    this.active = false; this.generation++;
    for (const task of this.tasks.values()) { clearTimeout(task.timer); task.timer = null; task.controller?.abort(); task.controller = null; }
  }
  trigger(name) {
    const task = this.tasks.get(name);
    if (!this.active || !task || task.controller) return;
    clearTimeout(task.timer);
    const generation = this.generation;
    const controller = new AbortController(); task.controller = controller;
    const started = Date.now();
    Promise.resolve().then(() => task.run(controller.signal)).then(() => {
      if (controller.signal.aborted) return;
      task.failures = 0; this.onSuccess(name);
    }).catch(error => {
      if (controller.signal.aborted) return;
      task.failures++; this.onError(name, error);
    }).finally(() => {
      if (task.controller === controller) task.controller = null;
      if (!this.active || generation !== this.generation) return;
      const interval = Math.min(15000, task.interval * 2 ** Math.min(task.failures, 3));
      task.timer = setTimeout(() => this.trigger(name), Math.max(100, interval - (Date.now() - started)));
    });
  }
}
