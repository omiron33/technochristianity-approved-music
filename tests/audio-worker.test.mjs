import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/audio.js";

const key = "audio/genesis-1/0123456789abcdef.mp3";
const bytes = new TextEncoder().encode("abcdefghij");
const metadata = {
  size: bytes.length,
  httpEtag: '"abc"',
  writeHttpMetadata(headers) { headers.set("Content-Type", "audio/mpeg"); },
};
const env = { AUDIO: {
  async head(path) { return path === key ? metadata : null; },
  async get(path, options) {
    if (path !== key) return null;
    const offset = options?.range?.offset ?? 0;
    const length = options?.range?.length ?? bytes.length;
    return { ...metadata, body: new Blob([bytes.slice(offset, offset + length)]).stream() };
  },
} };
const request = (method = "GET", range) => new Request(`https://media.example/${key}`, {
  method, headers: range ? { Range: range } : {},
});

test("serves only immutable audio with correct type and range semantics", async () => {
  const full = await worker.fetch(request(), env);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("Content-Type"), "audio/mpeg");
  assert.equal(full.headers.get("Accept-Ranges"), "bytes");
  assert.equal(await full.text(), "abcdefghij");

  const partial = await worker.fetch(request("GET", "bytes=3-5"), env);
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("Content-Range"), "bytes 3-5/10");
  assert.equal(await partial.text(), "def");

  const head = await worker.fetch(request("HEAD"), env);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Content-Length"), "10");
  assert.equal(await head.text(), "");
});

test("rejects writes, unrelated paths and unsatisfiable ranges", async () => {
  assert.equal((await worker.fetch(request("PUT"), env)).status, 405);
  assert.equal((await worker.fetch(new Request("https://media.example/secret"), env)).status, 404);
  const invalid = await worker.fetch(request("GET", "bytes=99-"), env);
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("Content-Range"), "bytes */10");
});
