import { review } from "./review";
import { runWatch } from "./watch";

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const dataFlag = args.find((a) => a.startsWith("--data="));
  const goalFlag = args.find((a) => a.startsWith("--goal="));
  const [cmd, game, ...rest] = args.filter((a) => !a.startsWith("--"));

  if (cmd === "watch" && game) {
    await runWatch(game, goalFlag?.slice(7) ?? "map", { dataDir: dataFlag?.slice(7) });
    return; // long-running; keeps the process alive via setInterval
  }

  if (cmd === "review" && game) {
    const question = rest.join(" ");
    const r = await review(game, question, { dataDir: dataFlag?.slice(7) });

    console.log(`\n📍 ${r.scene.locationGuess}  (confidence ${r.scene.confidence.toFixed(2)}, frame @ t=${r.t.toFixed(1)}s)`);
    console.log(`   on screen: ${r.scene.onScreen}`);
    console.log(`   exits: ${r.scene.visibleExits}\n`);
    console.log("🎙️  " + (r.rag.answer ?? "(no answer)") + "\n");
    if (flags.has("--sources")) {
      console.log("--- grounded in ---");
      r.rag.passages.slice(0, 4).forEach((p, i) =>
        console.log(`[${i + 1}] ${p.chunk.sourceId}: ${p.chunk.text.slice(0, 120).replace(/\s+/g, " ")}...`),
      );
    }
    return;
  }

  console.log("usage:\n  coach watch <game> [--goal=map] [--data=DIR]   live glanceable HUD\n  coach review <game> [your question...] [--sources]\n  (the capture daemon must be running)");
  process.exit(cmd ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
