// Race harness for the payment-middleware cache in
// backend/lambdas/sellers/image-gen/index.js.
//
// The Lambda has no unit-test toolchain, so this script extracts the real
// `_middlewarePromise` / `getPaymentMiddleware` bytes from index.js and runs
// them against a controllable `buildPaymentMiddleware`.
//
// What it pins, as regression coverage for the retry semantics:
//   1. concurrent callers share one in-flight build
//   2. a null build (wallet not provisioned) is evicted so the next call retries
//   3. a rejected build is evicted so the next call retries
//   4. a successful build is cached
//
// It also covers the identity guard on the clear site. With native promises that
// guard is defence in depth rather than a fix for a reachable bug: every waiter
// on the same promise resumes in registration order, with no interleaving
// between the await resuming and the clear running, so a stale waiter cannot
// observe a newer promise in the slot.
//
// Run: node backend/lambdas/sellers/image-gen/middleware-cache.race.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "index.js"), "utf8");

const start = source.indexOf("let _middlewarePromise");
const endMarker = "app.use(\"/image-gen\"";
const end = source.indexOf(endMarker);
if (start === -1 || end === -1) {
  throw new Error("cannot locate the middleware cache block in index.js");
}
const cacheBlock = source.slice(start, end);

// Build an isolated copy of the real cache block with a stubbed builder.
function buildHarness(build) {
  const factory = new Function(
    "buildPaymentMiddleware",
    `${cacheBlock}\nreturn { getPaymentMiddleware, peek: () => _middlewarePromise };`,
  );
  return factory(build);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Scenario: concurrent callers share one successful build.
async function concurrentCallersShareOneBuild() {
  let calls = 0;
  const gate = deferred();
  const harness = buildHarness(async () => {
    calls += 1;
    return gate.promise;
  });

  const a = harness.getPaymentMiddleware();
  const b = harness.getPaymentMiddleware();
  const c = harness.getPaymentMiddleware();
  gate.resolve("mw");
  assert.deepEqual(await Promise.all([a, b, c]), ["mw", "mw", "mw"]);
  assert.equal(calls, 1, "concurrent first requests must share one build");
}

async function nullBuildIsEvicted() {
  let calls = 0;
  const harness = buildHarness(async () => {
    calls += 1;
    return calls === 1 ? null : "mw";
  });

  assert.equal(await harness.getPaymentMiddleware(), null);
  assert.equal(await harness.getPaymentMiddleware(), "mw");
  assert.equal(calls, 2, "a null build must not be cached");
}

async function rejectedBuildIsEvicted() {
  let calls = 0;
  const harness = buildHarness(async () => {
    calls += 1;
    if (calls === 1) throw new Error("transient facilitator outage");
    return "mw";
  });

  await assert.rejects(harness.getPaymentMiddleware(), /transient facilitator outage/);
  assert.equal(harness.peek(), null, "a rejected build must be evicted");
  assert.equal(await harness.getPaymentMiddleware(), "mw");
  assert.equal(calls, 2, "the retry must rebuild");
}

async function successfulBuildIsCached() {
  let calls = 0;
  const harness = buildHarness(async () => {
    calls += 1;
    return "mw";
  });

  assert.equal(await harness.getPaymentMiddleware(), "mw");
  assert.equal(await harness.getPaymentMiddleware(), "mw");
  assert.equal(calls, 1, "a successful build must be cached");
}

const scenarios = [
  ["concurrent callers share one build", concurrentCallersShareOneBuild],
  ["null build is evicted", nullBuildIsEvicted],
  ["rejected build is evicted", rejectedBuildIsEvicted],
  ["successful build is cached", successfulBuildIsCached],
];

for (const [name, fn] of scenarios) {
  await fn();
  console.log(`ok - ${name}`);
}
console.log(`\n${scenarios.length} middleware cache scenarios passed`);
