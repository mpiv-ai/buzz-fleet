/** NIP-AO's RECOMMENDED bound for buffering unreplayable ephemeral (kind
 * 24200) events client-side: "Clients SHOULD buffer received events in a
 * bounded in-memory ring buffer... RECOMMENDED maximum: 800 events." */
export const DEFAULT_RING_BUFFER_CAPACITY = 800;

/** Fixed-capacity FIFO buffer. Oldest entries are dropped once `capacity` is
 * exceeded. Used to hold recent decoded telemetry per (relay, agent) pair —
 * kind 24200 is ephemeral and unreplayable, so this ring is the only history
 * this board ever has for it. */
export class RingBuffer<T> {
  private readonly items: T[] = [];

  constructor(private readonly capacity: number = DEFAULT_RING_BUFFER_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`RingBuffer: capacity must be a positive integer, got ${capacity}`);
    }
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.shift();
    }
  }

  toArray(): T[] {
    return [...this.items];
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }
}
