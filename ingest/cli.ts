import { ingestGame } from "./pipeline";

function flag(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a?.split("=")[1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const [cmd, game] = process.argv.slice(2).filter((a) => !a.startsWith("--"));

  if (cmd !== "ingest" || !game) {
    console.log(
      [
        "ingest — multi-game video knowledge ingestion",
        "",
        "  ingest <game> [--no-extract] [--per-segment=N] [--max-sources=N]",
        "",
        "    <game>           name of a registry under ingest/sources/<game>.json",
        "    --no-extract     run acquire+segment+keyframes only (no API key needed)",
        "    --per-segment=N  keyframes sampled per segment (default 3)",
        "    --max-sources=N  cap sources this run (default all)",
        "",
        "  extraction needs ANTHROPIC_API_KEY; everything else runs offline.",
      ].join("\n"),
    );
    process.exit(cmd ? 1 : 0);
  }

  const summary = await ingestGame(game, {
    extract: !has("no-extract"),
    perSegment: flag("per-segment") ? Number(flag("per-segment")) : 3,
    maxSources: flag("max-sources") ? Number(flag("max-sources")) : undefined,
    dropSingletons: has("drop-singletons"),
    llmSweep: has("llm-sweep"),
    verify: has("verify"),
  });

  console.log("\n=== ingest summary ===");
  console.log(JSON.stringify(summary, null, 2));
  if (summary.graphPath)
    console.log(
      `\nGenerated graph: ${summary.graphPath}\nValidate/eval it: npx tsx kb/validate.ts ../kb/${game}/graph.ingested.json`,
    );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
