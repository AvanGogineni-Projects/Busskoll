// Assert-based check for the pure helpers (no test runner in the frontend):
//   npm run check
import assert from "node:assert/strict";
import { bucket, dueIn, buildShape, distAt, fmtDelay, metres, monotonic, pointAt } from "../src/lib.ts";

const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);

// Shape: three points due east along a parallel near Stockholm; positions interpolate.
const shape = buildShape([[18.0, 59.33], [18.01, 59.33], [18.02, 59.33]]);
const leg = metres([18.0, 59.33], [18.01, 59.33]);
near(leg, 568, 2); // 0.01° of longitude at 59.33°N ≈ 568 m
near(shape.cum[2], 2 * leg, 1e-6);
assert.deepEqual(pointAt(shape, -5), [18.0, 59.33]); // clamped at the start
assert.deepEqual(pointAt(shape, 1e9), [18.02, 59.33]); // and at the end
near(pointAt(shape, leg * 1.5)[0], 18.015, 1e-9); // halfway along the second segment

// Track: linear between knots, holds outside them.
const track = [{ t: 100, d: 0 }, { t: 160, d: 600 }, { t: 220, d: 900 }];
assert.equal(distAt(track, 50), 0);
assert.equal(distAt(track, 130), 300);
assert.equal(distAt(track, 190), 750);
assert.equal(distAt(track, 999), 900); // waits at the last predicted stop
assert.equal(distAt([], 10), 0);

// A prediction already behind the previous knot can't move the bus backwards or divide by zero.
const fixed = monotonic([{ t: 100, d: 0 }, { t: 90, d: 300 }, { t: 90, d: 250 }]);
assert.deepEqual(fixed, [{ t: 100, d: 0 }, { t: 101, d: 300 }, { t: 102, d: 300 }]);
assert.ok(Number.isFinite(distAt(fixed, 100.5)));

// Delay buckets and formatting.
assert.equal(bucket(-61), "early");
assert.equal(bucket(-60), "ontime");
assert.equal(bucket(119), "ontime");
assert.equal(bucket(120), "late");
assert.equal(bucket(300), "verylate");
assert.equal(fmtDelay(125), "+2:05");
assert.equal(fmtDelay(-40), "−0:40");
assert.equal(fmtDelay(0), "±0:00");
const T = Date.parse("2026-11-03T07:30:00Z");
const at = (sec: number) => new Date(T + sec * 1000).toISOString();
assert.equal(dueIn(at(20), T), "now");
assert.equal(dueIn(at(-20), T), "now");
assert.equal(dueIn(at(-300), T), "now"); // overdue, not gone
assert.equal(dueIn(at(150), T), "3 min"); // 2.5 min rounds up
assert.equal(dueIn(at(89), T), "1 min");
console.log("lib checks passed");
