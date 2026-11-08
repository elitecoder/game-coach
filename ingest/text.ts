import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Source, Segment } from "./types";

export interface TextDoc {
  sourceId: string;
  title: string;
  url: string;
  text: string;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function fetchRetry(url: string, attempts = 3): Promise<Response> {
  let last: any;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, accept: "text/html,application/json,*/*" },
      });
      if (res.ok) return res;
      last = new Error(`${res.status}`);
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  throw last;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#?\w+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Acquire a TEXT source. For MediaWiki pages (…/wiki/Title — Fandom, etc.) use the API `extracts`
 * endpoint → clean article PROSE (no nav cruft, and dodges the HTML page's bot-403). Otherwise fetch
 * HTML and strip. Falls back HTML→ if the API yields nothing.
 */
export async function acquireText(source: Source, rawDir: string): Promise<TextDoc> {
  const url = source.url;
  if (!url) throw new Error(`text source ${source.id} needs a url`);
  const dir = join(rawDir, source.id);
  // snapshot-first: live pages drift, and drifted text would miss the content-addressed caches.
  // Delete _raw/<id>/page.json to re-fetch.
  try {
    return JSON.parse(await readFile(join(dir, "page.json"), "utf8")) as TextDoc;
  } catch {
    /* no snapshot yet */
  }

  let text = "";
  let title = source.id;

  const wiki = url.match(/^https?:\/\/([^/]+)\/wiki\/(.+)$/);
  if (wiki) {
    const [, host, titleRaw] = wiki;
    // action=parse&prop=text is core MediaWiki (works on Fandom; the API endpoint isn't bot-403'd
    // like the rendered page) and returns ARTICLE-ONLY html — no site nav cruft.
    const api =
      `https://${host}/api.php?action=parse&format=json&prop=text&redirects=1&page=` +
      encodeURIComponent(decodeURIComponent(titleRaw));
    try {
      const j: any = await (await fetchRetry(api)).json();
      const html = j?.parse?.text?.["*"] ?? "";
      text = stripHtml(html);
      title = j?.parse?.title ?? titleRaw;
    } catch {
      /* fall through to HTML */
    }
  }

  if (text.length < 200) {
    const html = await (await fetchRetry(url)).text();
    text = stripHtml(html);
    title = (html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? title).trim();
  }

  await mkdir(dir, { recursive: true });
  const doc = { sourceId: source.id, title, url, text };
  await writeFile(join(dir, "page.json"), JSON.stringify(doc));
  return doc;
}

const CHUNK_CHARS = 3500;

/** Chunk text into ~3.5k-char Segments (no keyframes), capped at maxChunks to bound cost. */
export function segmentText(doc: TextDoc, maxChunks = 15): Segment[] {
  const paras = doc.text.split(/\n{2,}/);
  const segs: Segment[] = [];
  let buf = "";
  let idx = 0;
  const flush = () => {
    if (!buf.trim()) return;
    segs.push({
      sourceId: doc.sourceId,
      videoId: doc.sourceId,
      index: idx,
      startSec: 0,
      endSec: 0,
      title: `${doc.title} #${idx + 1}`,
      transcript: buf.trim(),
      keyframePaths: [],
    });
    idx++;
    buf = "";
  };
  for (const p of paras) {
    if ((buf + p).length > CHUNK_CHARS) flush();
    buf += (buf ? "\n\n" : "") + p;
  }
  flush();
  return segs.slice(0, maxChunks);
}
