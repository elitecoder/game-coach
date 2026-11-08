import { buildIndex } from "./build";
import { ask } from "./ask";
import { evaluate } from "./eval";

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const [cmd, game, ...rest] = args.filter((a) => !a.startsWith("--"));

  if (cmd === "build" && game) {
    const n = await buildIndex(game, { context: !flags.has("--no-context") });
    console.log(`indexed ${n} chunks -> kb/${game}/rag-index.json`);
    return;
  }

  if (cmd === "ask" && game && rest.length) {
    const question = rest.join(" ");
    const r = await ask(game, question);
    if (r.answer) console.log("\n" + r.answer + "\n");
    else console.log("\n(no ANTHROPIC_API_KEY — showing retrieved passages only)\n");
    console.log(`--- hybrid retrieval (dense+BM25/RRF), top fused-score ${r.topScore.toFixed(4)} ---`);
    r.passages.slice(0, 5).forEach((p, i) =>
      console.log(`[${i + 1}] ${p.score.toFixed(4)} (${p.chunk.sourceId}) ${p.chunk.text.slice(0, 140).replace(/\s+/g, " ")}...`),
    );
    return;
  }

  if (cmd === "eval" && game) {
    console.log(`=== RAGAS-style eval: ${game} ===`);
    const rep = await evaluate(game);
    const a = rep.agg;
    console.log(
      `\n${game} aggregate (${rep.cases.length} cases):\n` +
        `  faithfulness     ${a.faithfulness.toFixed(3)}\n` +
        `  answer relevancy ${a.answerRelevancy.toFixed(3)}\n` +
        `  context relevancy${a.contextRelevancy.toFixed(3)}\n` +
        `  retrieval hit    ${a.retrievalHit.toFixed(3)}`,
    );
    return;
  }

  console.log("usage:\n  rag build <game> [--no-context]\n  rag ask <game> <question...>\n  rag eval <game>");
  process.exit(cmd ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
