const sha256 = /^[a-f\d]{64}$/i;

export function deliveredAudio(work, delivery) {
  if (delivery?.formatVersion !== 1 || delivery.provider !== "cloudflare-r2" ||
      typeof delivery.baseUrl !== "string" || !delivery.baseUrl.startsWith("https://")) return null;
  const item = delivery.objects?.find((candidate) =>
    candidate.workId === work.id && candidate.approvedTakeId === work.approvedTakeId);
  if (!item || !sha256.test(item.sha256 || "") || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 ||
      !Number.isFinite(Date.parse(item.verifiedAt || ""))) return null;
  const prefix = delivery.baseUrl.replace(/\/+$/, "") + "/audio/";
  if (typeof item.audioUrl !== "string" || !item.audioUrl.startsWith(prefix)) return null;
  const url = new URL(item.audioUrl);
  if (!/\.(mp3|m4a)$/.test(url.pathname) || url.search || url.hash) return null;
  return item.audioUrl;
}

export function queuedSunoFallback(work, delivery) {
  if (deliveredAudio(work, delivery)) return null;
  const queue = work.audioDownloadQueue;
  const take = work.takes?.find((entry) => entry.id === work.approvedTakeId && entry.approved);
  if (!["queued", "retrying"].includes(queue?.status) ||
      queue.approvedTakeId !== take?.id || queue.reason !== "download_limit" ||
      queue.source !== "suno_download_dialog" ||
      !Number.isFinite(Date.parse(queue.observedAt || "")) ||
      take.url !== `https://suno.com/song/${take.id}` || queue.url !== take.url)
    return null;
  return take.url;
}

export function verifiedYouTube(work) {
  const publication = work.publications?.youtube;
  if (publication?.status !== "verified" || publication.mediaChangePending) return null;
  try {
    const url = new URL(publication.url);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    let videoId;
    if (url.hostname === "youtu.be") {
      videoId = url.pathname.slice(1);
    } else if (["youtube.com", "www.youtube.com"].includes(url.hostname) &&
        url.pathname === "/watch" && url.searchParams.getAll("v").length === 1) {
      videoId = url.searchParams.get("v");
    }
    return /^[A-Za-z0-9_-]{11}$/.test(videoId || "")
      ? `https://www.youtube.com/watch?v=${videoId}` : null;
  } catch { return null; }
}
