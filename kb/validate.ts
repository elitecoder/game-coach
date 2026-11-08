import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateGraph, type GameGraph } from "./schema";

/** Usage: npx tsx kb/validate.ts hollow-knight/opening.graph.json */
async function main() {
  const rel = process.argv[2] ?? "hollow-knight/opening.graph.json";
  const path = join(import.meta.dirname, rel);
  const graph = JSON.parse(await readFile(path, "utf8")) as GameGraph;
  const issues = validateGraph(graph);

  const errors = issues.filter((i) => i.severity === "error");
  const warns = issues.filter((i) => i.severity === "warn");

  console.log(`graph: ${graph.game} — ${graph.scope}`);
  console.log(
    `nodes: ${graph.lattice.length} lattice, ${graph.zones.length} zones, ${graph.abilities.length} abilities/items, ${graph.bosses.length} bosses, ${graph.objectives.length} objectives, ${graph.connectors.length} connectors`,
  );
  console.log("");

  for (const w of warns) console.log(`  WARN  ${w.where}: ${w.message}`);
  for (const e of errors) console.log(`  ERROR ${e.where}: ${e.message}`);

  console.log("");
  if (errors.length) {
    console.log(`FAIL — ${errors.length} structural error(s).`);
    process.exit(1);
  }
  console.log(
    `OK — structurally sound. ${warns.length} unverified node(s) pending human QA (eval §0).`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
