import assert from "node:assert/strict";
import test from "node:test";
import { OneShotPrefetch, VersionedCache } from "../src/conversation-prefetch.ts";

test("接回身份预取：点开时拿走预取的那份，拿过一次就不再给", async () => {
  let calls = 0;
  const load = () => Promise.resolve(++calls);
  const cache = new OneShotPrefetch<number>(10_000, () => 0);
  cache.prefetch("a", load);
  cache.prefetch("a", load); // 还新鲜：不重复取
  assert.equal(calls, 1);
  assert.equal(await cache.take("a", load), 1);
  // 用过就扔：Run 发第一句后才登记，不能拿旧的「没有 Run」再开一次
  assert.equal(await cache.take("a", load), 2);
});

test("接回身份预取：过期的不用，现取", async () => {
  let now = 0;
  let calls = 0;
  const load = () => Promise.resolve(++calls);
  const cache = new OneShotPrefetch<number>(10_000, () => now);
  cache.prefetch("a", load);
  now = 10_000;
  assert.equal(await cache.take("a", load), 2);
});

test("记录页缓存：版本没变就复用，变了重取", async () => {
  let calls = 0;
  const load = () => Promise.resolve(++calls);
  const cache = new VersionedCache<number>(4);
  assert.equal(await cache.get("f", "v1", load), 1);
  assert.equal(await cache.get("f", "v1", load), 1);
  assert.equal(await cache.get("f", "v2", load), 2);
});

test("记录页缓存：取失败的不留，下次重取", async () => {
  let fail = true;
  const load = () => (fail ? Promise.reject(new Error("x")) : Promise.resolve(7));
  const cache = new VersionedCache<number>(4);
  await assert.rejects(cache.get("f", "v", load));
  await Promise.resolve();
  fail = false;
  assert.equal(await cache.get("f", "v", load), 7);
});

test("记录页缓存：超过上限扔最久没用过的", async () => {
  let calls = 0;
  const load = () => Promise.resolve(++calls);
  const cache = new VersionedCache<number>(2);
  await cache.get("a", "v", load); // 1
  await cache.get("b", "v", load); // 2
  await cache.get("a", "v", load); // 复用，a 变成最近用过
  await cache.get("c", "v", load); // 3，扔掉 b
  assert.equal(await cache.get("a", "v", load), 1);
  assert.equal(await cache.get("b", "v", load), 4);
});
