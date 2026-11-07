import { expect, it, vi } from "vitest";
import { ViewRequest } from "./ViewRequest";

it("rejects delayed A data and errors after selecting B, with one active read", async () => {
  const owner = new ViewRequest(); const apply = vi.fn();
  let finish!: (value: string) => void;
  owner.select("A");
  const a = owner.run("A", () => new Promise<string>(resolve => { finish = resolve; }), apply, false);
  await Promise.resolve();
  owner.select("B"); const bRead = vi.fn(async () => "B");
  const b = owner.run("B", bRead, apply, false);
  expect(bRead).not.toHaveBeenCalled();
  finish("A"); await a; await b;
  expect(apply.mock.calls).toEqual([["B"]]);
  owner.select("A"); let fail!: (value: unknown) => void;
  const old = owner.run("A", () => new Promise((_resolve, reject) => { fail = reject; }), apply, false);
  await Promise.resolve(); owner.select("B"); fail(Error("old view")); await expect(old).resolves.toBeUndefined();
});

it("coalesces navigation reads and queues one fresh refresh after a write", async () => {
  const owner = new ViewRequest(); owner.select("deck"); const apply = vi.fn();
  let finish!: (value: number) => void;
  const read = vi.fn(() => new Promise<number>(resolve => { finish = resolve; }));
  const first = owner.run("deck", read, apply, false);
  const duplicate = owner.run("deck", read, apply, false);
  expect(duplicate).toBe(first); await Promise.resolve(); expect(read).toHaveBeenCalledTimes(1);
  const afterWrite = owner.run("deck", async () => 2, apply);
  finish(1); await first; await afterWrite;
  expect(apply.mock.calls).toEqual([[2]]);
});
