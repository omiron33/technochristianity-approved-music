// Public read-only delivery for immutable, approved audio in a private R2 bucket.
const AUDIO_KEY = /^audio\/[a-z0-9-]+\/[a-f0-9]{16}\.(mp3|m4a)$/;

function headersFor(object, length) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(length));
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("ETag", object.httpEtag);
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

function requestedRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end, length: end - start + 1 };
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    const url = new URL(request.url);
    const key = url.pathname.slice(1);
    if (!AUDIO_KEY.test(key) || url.search || url.hash)
      return new Response("Not Found", { status: 404 });

    const rangeHeader = request.headers.get("Range");
    if (request.method === "HEAD" || rangeHeader) {
      const metadata = await env.AUDIO.head(key);
      if (!metadata) return new Response("Not Found", { status: 404 });
      const range = rangeHeader ? requestedRange(rangeHeader, metadata.size) : null;
      if (rangeHeader && !range)
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${metadata.size}`, "Accept-Ranges": "bytes" } });
      const headers = headersFor(metadata, range ? range.length : metadata.size);
      if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${metadata.size}`);
      if (request.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
      const object = await env.AUDIO.get(key, { range: { offset: range.start, length: range.length } });
      if (!object) return new Response("Not Found", { status: 404 });
      return new Response(object.body, { status: 206, headers });
    }

    const object = await env.AUDIO.get(key);
    if (!object) return new Response("Not Found", { status: 404 });
    return new Response(object.body, { status: 200, headers: headersFor(object, object.size) });
  },
};
