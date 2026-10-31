import assert from "node:assert/strict";
import test from "node:test";
import { createImageLru, imageMime } from "../src/image-cache.ts";

test("读图缓存：命中刷新新旧次序，超条数淘汰最久没用的并释放地址", () => {
  const revoked: string[] = [];
  const lru = createImageLru({ capCount: 2, capBytes: 1000, revoke: (u) => revoked.push(u) });
  lru.set("/a.png", "blob:a", 10);
  lru.set("/b.png", "blob:b", 10);
  assert.equal(lru.get("/a.png"), "blob:a");
  lru.set("/c.png", "blob:c", 10);
  assert.equal(lru.get("/b.png"), undefined);
  assert.deepEqual(revoked, ["blob:b"]);
  assert.equal(lru.get("/a.png"), "blob:a");
  assert.equal(lru.get("/c.png"), "blob:c");
});

test("读图缓存：按字节上限淘汰，最新一条即使自己超限也留着", () => {
  const revoked: string[] = [];
  const lru = createImageLru({ capCount: 10, capBytes: 100, revoke: (u) => revoked.push(u) });
  lru.set("/a.png", "blob:a", 60);
  lru.set("/b.png", "blob:b", 60);
  assert.deepEqual(revoked, ["blob:a"]);
  lru.set("/huge.png", "blob:huge", 500);
  assert.deepEqual(revoked, ["blob:a", "blob:b"]);
  assert.equal(lru.get("/huge.png"), "blob:huge");
  assert.equal(lru.size, 1);
  assert.equal(lru.bytes, 500);
});

test("读图缓存：同一路径重存时释放旧地址、字节不重复计", () => {
  const revoked: string[] = [];
  const lru = createImageLru({ capCount: 10, capBytes: 1000, revoke: (u) => revoked.push(u) });
  lru.set("/a.png", "blob:a1", 40);
  lru.set("/a.png", "blob:a2", 50);
  assert.deepEqual(revoked, ["blob:a1"]);
  assert.equal(lru.bytes, 50);
  assert.equal(lru.get("/a.png"), "blob:a2");
});

test("读图缓存：磁盘换版时单删一条，不释放屏上还在用的旧地址", () => {
  const revoked: string[] = [];
  const lru = createImageLru({ capCount: 4, capBytes: 1000, revoke: (u) => revoked.push(u) });
  lru.set("a", "blob:a", 10);
  lru.set("b", "blob:b", 20);
  lru.delete("a");
  assert.equal(lru.get("a"), undefined);
  assert.equal(lru.size, 1);
  assert.equal(lru.bytes, 20);
  assert.deepEqual(revoked, []);
  lru.delete("missing");
  assert.equal(lru.size, 1);
});

test("二进制读图按扩展名给 mime（svg 不带对类型画不出来）", () => {
  assert.equal(imageMime("/a/b.PNG"), "image/png");
  assert.equal(imageMime("C:\\x\\y.jpeg"), "image/jpeg");
  assert.equal(imageMime("~/z.jpg"), "image/jpeg");
  assert.equal(imageMime("/fig.svg"), "image/svg+xml");
  assert.equal(imageMime("/fig.webp"), "image/webp");
  assert.equal(imageMime("/v1.2/noext"), "application/octet-stream");
});
