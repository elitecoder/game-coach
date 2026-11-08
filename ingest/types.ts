/** Per-game source registry entry. `query` uses yt-dlp search (avoids dead URLs); `url` is explicit. */
export interface Source {
  id: string;
  kind: "video" | "text";
  query?: string; // video: e.g. "ytsearch1:hollow knight false knight boss guide"
  url?: string; // text: a wiki/walkthrough page; video: an explicit URL
  topic?: string; // optional human hint about what this source covers
}

export interface SourceRegistry {
  game: string;
  sources: Source[];
}

/** Result of acquiring one source via yt-dlp. */
export interface Acquired {
  sourceId: string;
  videoId: string;
  title: string;
  durationSec: number;
  webpageUrl: string;
  videoPath: string;
  subtitlePath?: string;
  chapters: Chapter[];
}

export interface Chapter {
  startSec: number;
  endSec: number;
  title: string;
}

/** An entity-aligned chunk of a source (a chapter, or a fallback time window). */
export interface Segment {
  sourceId: string;
  videoId: string;
  index: number;
  startSec: number;
  endSec: number;
  title: string;
  transcript: string;
  keyframePaths: string[];
}

// ---- VLM extraction output (natural-language-ish; fuse assigns ids + wires gates) ----

export interface ExtractedMilestone {
  name: string;
  kind: "boss_defeat" | "ability" | "zone_entry" | "item" | "event";
  note?: string;
}
export interface ExtractedZone {
  name: string;
  fingerprintHint?: string;
  note?: string;
}
export interface ExtractedAbility {
  name: string;
  type: "ability" | "key_item";
  acquiredAtZone?: string;
  grants?: string;
  note?: string;
}
export interface ExtractedBoss {
  name: string;
  zone?: string;
  note?: string;
}
export interface ExtractedObjective {
  name: string;
  zoneContext?: string;
  hopDescription: string;
  leadsToMilestone?: string;
  note?: string;
}
export interface ExtractedConnector {
  fromZone: string;
  toZone: string;
  bidirectional: boolean;
  requiresAbilityOrItem?: string;
  description: string;
  note?: string;
}

export interface Fragment {
  milestones: ExtractedMilestone[];
  zones: ExtractedZone[];
  abilities: ExtractedAbility[];
  bosses: ExtractedBoss[];
  objectives: ExtractedObjective[];
  connectors: ExtractedConnector[];
  /** model's estimate of how far into the game this segment sits, 0 (start) .. 1 (end). */
  segmentProgressionRank: number;
}

/** Provenance sidecar: nodeId -> where it came from (§7.2 cross-source fusion + weighting). */
export interface ProvenanceEntry {
  sourceId: string;
  videoId: string;
  segmentIndex: number;
  segmentTitle: string;
  startSec: number;
  endSec: number;
}
export type ProvenanceStore = Record<string, ProvenanceEntry[]>;

export interface Conflict {
  nodeId: string;
  field: string;
  values: { value: string; sourceId: string }[];
}
