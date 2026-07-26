import { describe, expect, it } from "vitest";
import { RingBuffer, DEFAULT_RING_BUFFER_CAPACITY } from "../../src/turns/ringBuffer";

describe("RingBuffer", () => {
  it("returns pushed items in insertion order", () => {
    const buffer = new RingBuffer<number>(5);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);

    expect(buffer.toArray()).toEqual([1, 2, 3]);
    expect(buffer.size).toBe(3);
  });

  it("drops the oldest entries once capacity is exceeded", () => {
    const buffer = new RingBuffer<number>(3);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    buffer.push(4);
    buffer.push(5);

    expect(buffer.toArray()).toEqual([3, 4, 5]);
    expect(buffer.size).toBe(3);
  });

  it("never grows past its configured capacity across many pushes", () => {
    const buffer = new RingBuffer<number>(10);
    for (let i = 0; i < 1000; i++) {
      buffer.push(i);
    }

    expect(buffer.size).toBe(10);
    expect(buffer.toArray()).toEqual([990, 991, 992, 993, 994, 995, 996, 997, 998, 999]);
  });

  it("defaults to the NIP-AO recommended 800-event capacity", () => {
    expect(DEFAULT_RING_BUFFER_CAPACITY).toBe(800);
    const buffer = new RingBuffer<number>();
    for (let i = 0; i < 850; i++) {
      buffer.push(i);
    }
    expect(buffer.size).toBe(800);
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new RingBuffer<number>(0)).toThrow();
    expect(() => new RingBuffer<number>(-1)).toThrow();
  });

  it("clear() empties the buffer", () => {
    const buffer = new RingBuffer<number>(3);
    buffer.push(1);
    buffer.push(2);
    buffer.clear();

    expect(buffer.toArray()).toEqual([]);
    expect(buffer.size).toBe(0);
  });
});
