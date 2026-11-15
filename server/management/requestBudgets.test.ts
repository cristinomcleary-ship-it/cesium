import test from "node:test";
import assert from "node:assert/strict";
import { BufferedUploadBudget, LoginAttemptBudget } from "./requestBudgets.ts";

test("login windows renew and expired username keys release their bounded capacity", () => {
  let now = 1000;
  const budget = new LoginAttemptBudget(() => now, 2, 100, 2);
  budget.check("a"); budget.fail("a"); budget.check("a"); budget.fail("a");
  assert.throws(() => budget.check("a"), { code: "LOGIN_RATE_LIMIT" });
  budget.check("b"); budget.fail("b");
  assert.throws(() => budget.check("c"), { code: "LOGIN_RATE_LIMIT" });
  now += 100;
  budget.check("c"); budget.fail("c");
  budget.check("a"); budget.fail("a"); budget.check("a"); budget.fail("a");
  assert.throws(() => budget.check("a"), { code: "LOGIN_RATE_LIMIT" });
  budget.clear("a"); budget.check("a");
  budget.clear(); budget.check("b");
});

test("buffer budget counts concat peak, preserves other leases, and releases exactly once", () => {
  const budget = new BufferedUploadBudget({ maxConcurrent: 2, maxBufferedBytes: 20 });
  const first = budget.acquire(), second = budget.acquire();
  assert.throws(() => budget.acquire(), { code: "UPLOAD_BUSY" });
  first.reserve(6); second.reserve(4);
  assert.throws(() => second.reserve(1), { code: "UPLOAD_MEMORY_LIMIT" });
  first.release(); first.release();
  second.reserve(6);
  const third = budget.acquire();
  assert.throws(() => third.reserve(1), { code: "UPLOAD_MEMORY_LIMIT" });
  second.release(); third.reserve(10); third.release();
  assert.throws(() => first.reserve(1), /already released/);
  assert.throws(() => new BufferedUploadBudget({ maxConcurrent: 0 }), /positive integers/);
});
