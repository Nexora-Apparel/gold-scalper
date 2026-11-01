export class ScalpingEventJournalClient {
  constructor({ endpoint = "/api/scalping-events", fetchImpl = globalThis.fetch, maxQueue = 500, batchSize = 50, onStatus = () => {} } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.maxQueue = maxQueue;
    this.batchSize = batchSize;
    this.onStatus = onStatus;
    this.queue = [];
    this.flushing = false;
    this.dropped = 0;
  }

  enqueue(event) {
    if (!event || typeof event.eventId !== "string" || !event.eventId) return false;
    if (this.queue.some(item => item.eventId === event.eventId)) return true;
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
      this.dropped += 1;
    }
    this.queue.push(event);
    this.onStatus({ state: "queued", pending: this.queue.length, dropped: this.dropped });
    return true;
  }

  async flush() {
    if (this.flushing || !this.queue.length) return { sent: 0, pending: this.queue.length };
    this.flushing = true;
    let sent = 0;
    try {
      while (this.queue.length) {
        const batch = this.queue.slice(0, this.batchSize);
        const response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(batch)
        });
        if (!response.ok) throw new Error(`Event journal HTTP ${response.status}`);
        const result = await response.json();
        if (!result?.saved || Number(result.received) !== batch.length) throw new Error("Event journal did not confirm the complete batch.");
        this.queue.splice(0, batch.length);
        sent += Number(result.inserted) || 0;
        this.onStatus({ state: "flushed", sent, pending: this.queue.length, dropped: this.dropped });
      }
      return { sent, pending: 0 };
    } catch (error) {
      this.onStatus({ state: "flush_failed", sent, pending: this.queue.length, error: String(error?.message || error) });
      return { sent, pending: this.queue.length, error };
    } finally {
      this.flushing = false;
    }
  }
}
