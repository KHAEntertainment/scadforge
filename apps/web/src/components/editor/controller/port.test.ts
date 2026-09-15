// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { TransactionPort } from "./port.js";

describe("TransactionPort", () => {
  it("starts empty", () => {
    const port = new TransactionPort();
    expect(port.read()).toEqual({ status: "empty", generation: 0 });
  });

  it("accepts a sample at a newer generation and notifies", () => {
    const port = new TransactionPort();
    const listener = vi.fn();
    port.subscribe(listener);

    port.write({ value: 4, generation: 1 });

    expect(port.read()).toEqual({ status: "sample", value: 4, generation: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale sample write (lower generation) and does not notify", () => {
    const port = new TransactionPort();
    port.write({ value: 4, generation: 2 });
    const listener = vi.fn();
    port.subscribe(listener);

    port.write({ value: 999, generation: 1 });

    expect(port.read()).toEqual({ status: "sample", value: 4, generation: 2 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("ignores a second write at an already-resolved generation", () => {
    const port = new TransactionPort();
    port.write({ value: 4, generation: 1 });
    const listener = vi.fn();
    port.subscribe(listener);

    port.write({ value: 5, generation: 1 });

    expect(port.read()).toEqual({ status: "sample", value: 4, generation: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("records a failure at a newer generation and notifies", () => {
    const port = new TransactionPort();
    const listener = vi.fn();
    port.subscribe(listener);

    port.fail(1);

    expect(port.read()).toEqual({ status: "failed", generation: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale failure", () => {
    const port = new TransactionPort();
    port.write({ value: 4, generation: 2 });
    const listener = vi.fn();
    port.subscribe(listener);

    port.fail(1);

    expect(port.read()).toEqual({ status: "sample", value: 4, generation: 2 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("reset realigns to empty at a fresh generation without notifying", () => {
    const port = new TransactionPort();
    port.write({ value: 4, generation: 1 });
    const listener = vi.fn();
    port.subscribe(listener);

    port.reset(2);

    expect(port.read()).toEqual({ status: "empty", generation: 2 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("unsubscribe stops further notifications", () => {
    const port = new TransactionPort();
    const listener = vi.fn();
    const unsubscribe = port.subscribe(listener);
    unsubscribe();

    port.write({ value: 1, generation: 1 });

    expect(listener).not.toHaveBeenCalled();
  });
});
