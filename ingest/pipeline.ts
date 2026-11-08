import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SourceRegistry, Segment, Fragment } from "./types";
import { acquire } from "./acquire";
import { acquireText, segmentText } from "./text";
import { segment } from "./segment";
import { sampleKeyframes } from "./keyframes";
import { extractSegment } from "./extract";
import { fragKey, getCached, putCached } from "./cache";
import { fuse } from "./fuse";
import { refine } from "./refine";
import { llmSweep, type Verdict } from "./llm-sweep";
import { verify, type Decision } from "./verify";
import { validateGraph } from "../kb/schema";

export interface IngestOptions {
  extract: boolean;
  perSegment: number;
  maxSources?: number;
  durationCapSec?: number;
  extractConcurrency?: number;
  dropSingletons?: boolean;
  llmSweep?: boolean;
  verify?: boolean;
}

export interface IngestSummary {
  game: string;
  sources: number;
  sourcesFailed: string[];
  videoSegments: number;
  textSegments: number;
  keyframes: number;
  fragments: number;
  graphPath?: string;
  graphNodes?: number;
  validationErrors?: number;
  validationWarnings?: number;
  droppedArtifacts?: number;
  contamination?: number;
  singleSourceFlags?: number;
  corroborated?: number;
  autoVerified?: number;
  panelDropped?: number;
  escalated?: number;
}

const kbRoot = join(import.meta.dirname, "..", "kb");

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (t: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function ingestGame(
  game: string,
  opts: IngestOptions,
): Promise<IngestSummary> {
  const registry = JSON.parse(
    await readFile(join(import.meta.dirname, "sources", `${game}.json`), "utf8"),
  ) as SourceRegistry;

  const gameDir = join(kbRoot, game);
  const rawDir = join(gameDir, "_raw");
  const keyframeDir = join(gameDir, "_keyframes");
  await mkdir(gameDir, { recursive: true });

  const sources = registry.sources.slice(0, opts.maxSources ?? registry.sources.length);
  const manifest: any[] = [];
  const sourcesFailed: string[] = [];
  const allSegments: { seg: Segment; topic?: string }[] = [];
  let videoSegments = 0;
  let textSegments = 0;
  let keyframes = 0;

  for (const source of sources) {
    try {
      let segs: Segment[];
      let meta: any;
      if (source.kind === "text") {
        console.log(`[ingest] fetching TEXT ${source.id} (${source.url})`);
        const doc = await acquireText(source, rawDir);
        segs = segmentText(doc);
        textSegments += segs.length;
        meta = { kind: "text", title: doc.title, url: doc.url, segments: segs.length };
      } else {
        console.log(`[ingest] acquiring VIDEO ${source.id} (${source.query ?? source.url})`);
        const acq = await acquire(source, rawDir, opts.durationCapSec ?? 1200);
        let s = await segment(acq);
        s = await sampleKeyframes(acq, s, keyframeDir, opts.perSegment);
        segs = s;
        videoSegments += segs.length;
        keyframes += segs.reduce((n, x) => n + x.keyframePaths.length, 0);
        meta = {
          kind: "video",
          title: acq.title,
          url: acq.webpageUrl,
          durationSec: acq.durationSec,
          usedChapters: acq.chapters.length > 0,
          segments: segs.length,
        };
      }
      console.log(`[ingest]   "${meta.title}" — ${segs.length} segments`);
      manifest.push({ sourceId: source.id, ...meta });
      for (const seg of segs) allSegments.push({ seg, topic: source.topic });
    } catch (e: any) {
      console.warn(`[ingest] source ${source.id} FAILED: ${e.message}`);
      sourcesFailed.push(source.id);
    }
  }

  await writeFile(join(gameDir, "_ingest_manifest.json"), JSON.stringify(manifest, null, 2));

  const fragInputs: { fragment: Fragment; segment: Segment }[] = [];
  if (opts.extract && allSegments.length > 0) {
    const cacheDir = join(gameDir, "_fragcache");
    const model = process.env.COACH_EXTRACT_MODEL ?? "claude-sonnet-4-6";
    console.log(`[ingest] extracting ${allSegments.length} segments via VLM (. new  c cached  x failed)...`);
    const results = await mapLimit(
      allSegments,
      opts.extractConcurrency ?? 4,
      async ({ seg, topic }) => {
        const key = fragKey(game, seg, model);
        const cached = await getCached(cacheDir, key);
        if (cached) {
          process.stdout.write("c");
          return { fragment: cached, segment: seg };
        }
        try {
          const fragment = await extractSegment(game, seg, topic);
          await putCached(cacheDir, key, fragment);
          process.stdout.write(".");
          return { fragment, segment: seg };
        } catch {
          process.stdout.write("x");
          return null;
        }
      },
    );
    process.stdout.write("\n");
    for (const r of results) if (r) fragInputs.push(r);
  }

  const summary: IngestSummary = {
    game,
    sources: sources.length,
    sourcesFailed,
    videoSegments,
    textSegments,
    keyframes,
    fragments: fragInputs.length,
  };

  if (opts.extract && fragInputs.length > 0) {
    const { graph: rawGraph, provenance, conflicts } = fuse(game, fragInputs);

    let sweep: Map<string, Verdict> | undefined;
    let decisions: Map<string, Decision> | undefined;

    if (opts.verify) {
      // auto-QA: ground -> corroborate -> adversarial panel -> escalate only disagreements
      console.log(`[ingest] auto-QA verify (c cached  V panel  v failed)...`);
      const r = await verify(game, rawGraph, provenance, gameDir);
      decisions = r.decisions;
      await writeFile(join(gameDir, "verification.json"), JSON.stringify(r.report, null, 2));
      const escalations = [...r.decisions.entries()]
        .filter(([, d]) => d.decision === "escalate")
        .map(([id, d]) => ({ id, ...d }));
      await writeFile(join(gameDir, "escalations.json"), JSON.stringify(escalations, null, 2));
      summary.autoVerified = r.report.corroborated + r.report.panelKept;
      summary.panelDropped = r.report.panelDropped;
      summary.escalated = r.report.escalated;
    } else if (opts.llmSweep) {
      // sweep NAMED entities only. Objectives are action phrases ("Descend into the caverns") —
      // the entity-vs-descriptor / membership test misfires on them, so they keep the regex check.
      const ents = [
        ...rawGraph.zones.map((z) => ({ id: z.id, name: z.name, kind: "zone" })),
        ...rawGraph.abilities.map((a) => ({ id: a.id, name: a.name, kind: a.type })),
        ...rawGraph.bosses.map((b) => ({ id: b.id, name: b.name, kind: "boss" })),
      ];
      console.log(`[ingest] LLM sweep over ${ents.length} entities (S batch  s failed)...`);
      sweep = await llmSweep(game, ents, join(gameDir, "_sweepcache"));
    }

    const { graph, report } = refine(rawGraph, provenance, {
      dropSingletons: opts.dropSingletons,
      sweep,
      decisions,
    });

    const graphPath = join(gameDir, "graph.ingested.json");
    await writeFile(graphPath, JSON.stringify(graph, null, 2)); // refined (the consumable graph)
    await writeFile(join(gameDir, "graph.raw.json"), JSON.stringify(rawGraph, null, 2)); // pre-refine
    await writeFile(join(gameDir, "quality.json"), JSON.stringify(report, null, 2));
    await writeFile(join(gameDir, "provenance.json"), JSON.stringify(provenance, null, 2));
    await writeFile(join(gameDir, "conflicts.json"), JSON.stringify(conflicts, null, 2));

    const issues = validateGraph(graph);
    summary.graphPath = graphPath;
    summary.graphNodes =
      graph.lattice.length +
      graph.zones.length +
      graph.abilities.length +
      graph.bosses.length +
      graph.objectives.length +
      graph.connectors.length;
    summary.validationErrors = issues.filter((i) => i.severity === "error").length;
    summary.validationWarnings = issues.filter((i) => i.severity === "warn").length;
    summary.droppedArtifacts = report.droppedArtifacts.length;
    summary.contamination = report.contamination.length;
    summary.singleSourceFlags = report.singleSource.length;
    summary.corroborated = report.corroborated;
  }

  return summary;
}
