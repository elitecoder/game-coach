import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GameGraph } from "../kb/schema";
import { deliveredSlice } from "./filter";
import { buildVocab, checkGrounding, checkUsefulness } from "./grounding";
import { sweep } from "./markers";
import { COACHES, type Coach } from "./coaches";

interface CaseResult {
  label: string;
  query: string;
  answer: string;
  leaks: string[];
  useful: boolean;
}

async function runCoach(
  graph: GameGraph,
  coach: Coach,
): Promise<CaseResult[]> {
  const vocab = buildVocab(graph);
  const out: CaseResult[] = [];
  for (const c of sweep(graph)) {
    const answer = await coach(graph, c.marker, c.location);
    const slice = deliveredSlice(graph, c.marker);
    const grounding = checkGrounding(answer, slice.ids, vocab);
    out.push({
      label: c.label,
      query: c.query,
      answer,
      leaks: grounding.leaks.map((l) => l.matched),
      useful: checkUsefulness(answer),
    });
  }
  return out;
}

function summarize(name: string, results: CaseResult[]) {
  const leakCases = results.filter((r) => r.leaks.length > 0);
  const uselessCases = results.filter((r) => !r.useful);
  console.log(`\n=== coach: ${name} ===`);
  console.log(
    `  cases: ${results.length} | HARD leaks: ${leakCases.length} | SOFT useless: ${uselessCases.length}`,
  );
  for (const r of leakCases)
    console.log(`  LEAK  ${r.label}: named [${r.leaks.join(", ")}] — "${r.answer}"`);
  for (const r of uselessCases)
    console.log(`  weak  ${r.label}: no concrete direction — "${r.answer}"`);
  return { leaks: leakCases.length, useless: uselessCases.length };
}

async function main() {
  const graphPath = join(
    import.meta.dirname,
    "../kb/hollow-knight/opening.graph.json",
  );
  const graph = JSON.parse(await readFile(graphPath, "utf8")) as GameGraph;

  const args = process.argv.slice(2);
  const demo = args.includes("--demo") || args.length === 0;
  const coachArg = args.find((a) => a.startsWith("--coach="))?.split("=")[1];

  if (demo) {
    console.log("Reveal-gate eval — demonstration across three coaches.");
    console.log(`graph: ${graph.game} (${graph.lattice.length} milestones swept)`);
    const safe = summarize("safe (reference agent)", await runCoach(graph, COACHES.safe));
    const leaky = summarize("leaky (volunteers a spoiler)", await runCoach(graph, COACHES.leaky));
    const useless = summarize("useless (safe but unhelpful)", await runCoach(graph, COACHES.useless));

    // The eval is FUNCTIONING if it: passes safe, catches leaky's leak (hard), flags useless (soft).
    const ok =
      safe.leaks === 0 && leaky.leaks > 0 && useless.useless > 0 && useless.leaks === 0;
    console.log("\n" + "-".repeat(60));
    console.log(
      ok
        ? "EVAL WORKS: safe passes (0 leaks), leaky is caught (hard-fail), useless is flagged (soft)."
        : "EVAL BROKEN: did not discriminate as expected.",
    );
    process.exit(ok ? 0 : 1);
  }

  // build-gate mode: evaluate ONE coach; any hard leak fails the build.
  const name = coachArg ?? "safe";
  const coach = COACHES[name];
  if (!coach) throw new Error(`unknown coach '${name}'`);
  const results = await runCoach(graph, coach);
  const { leaks } = summarize(name, results);
  console.log("\n" + "-".repeat(60));
  if (leaks > 0) {
    console.log(`BUILD FAILS: ${leaks} hard leak(s).`);
    process.exit(1);
  }
  console.log("BUILD GATE PASS: 0 leaks.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
