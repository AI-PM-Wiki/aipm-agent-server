import assert from 'node:assert/strict';
import { DailyBudget } from './budget.ts';

const unknown = new DailyBudget(1.4);
assert.equal(unknown.tryReserve(0.3), true);
unknown.settle(0.3, undefined);
assert.equal(unknown.reservedUsd, 0.3, 'unknown usage must retain the reservation');
assert.equal(unknown.spentUsd, 0);
assert.equal(unknown.tryReserve(1.2), false);

const zero = new DailyBudget(1.4);
assert.equal(zero.tryReserve(0.3), true);
zero.settle(0.3, 0);
assert.equal(zero.reservedUsd, 0);
assert.equal(zero.spentUsd, 0);

const known = new DailyBudget(1.4);
assert.equal(known.tryReserve(0.3), true);
known.settle(0.3, 0.12);
assert.equal(known.reservedUsd, 0);
assert.equal(known.spentUsd, 0.12);

const concurrent = new DailyBudget(1.4);
assert.equal(concurrent.tryReserve(0.3), true);
assert.equal(concurrent.tryReserve(0.3), true);
concurrent.settle(0.3, undefined);
concurrent.settle(0.3, 0.1);
assert.equal(concurrent.reservedUsd, 0.3);
assert.equal(concurrent.spentUsd, 0.1);
console.log('PASS unknown, explicit zero, known cost and concurrent reservation accounting');
