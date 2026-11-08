import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ask } from "./ask";
import { indexText } from "./build";
import { tokenize } from "./bm25";
import { loadDotEnv } from "../ingest/env";

/**
 * RAGAS-style, LLM-judged eval (no human annotation):
 *  - faithfulness:    fraction of answer claims supported by retrieved context (anti-hallucination)
 *  - answerRelevancy: does the answer actually address the question
 *  - contextRelevancy:fraction of retrieved passages relevant to the question (retrieval precision)
 *  - retrievalHit:    deterministic — did the must-include facts appear in retrieved passages
 */

interface EvalCase {
  question: string;
  mustInclude: string[];
}

interface CaseResult extends EvalCase {
  answer: string;
  topScore: number;
  retrievalHit: number;
  faithfulness: number;
  answerRelevancy: number;
  contextRelevancy: number;
}

const JUDGE_TOOL = {
  name: "report_scores",
  description: "Report RAGAS-style scores for one RAG answer.",
  input_schema: {
    type: "object",
    properties: {
      faithfulness: { type: "number", description: "0-1: fraction of answer claims supported by the context passages." },
      answer_relevancy: { type: "number", description: "0-1: how directly the answer addresses the question." },
      context_relevancy: { type: "number", description: "0-1: fraction of the provided passages that are relevant to the question." },
      notes: { type: "string", description: "One short sentence: any hallucinated claim or key miss." },
    },
    required: ["faithfulness", "answer_relevancy", "context_relevancy", "notes"],
  },
} as const;

async function judge(apiKey: string, game: string, question: string, answer: string, context: string) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.COACH_EVAL_MODEL ?? "claude-sonnet-4-6",
      max_tokens: 600,
      tool_choice: { type: "tool", name: "report_scores" },
      tools: [JUDGE_TOOL],
      system:
        `You are a strict RAG evaluator for the game "${game}". Judge ONLY against the provided context — ` +
        `a claim not supported by the passages is unfaithful even if it is true in general. Be harsh on hallucination.`,
      messages: [
        {
          role: "user",
          content: `Question: ${question}\n\nRetrieved context passages:\n${context}\n\nRAG answer:\n${answer}\n\nScore it.`,
        },
      ],
    }),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${JSON.stringify(data).slice(0, 160)}`);
  const tu = (data.content ?? []).find((b: any) => b.type === "tool_use");
  return (tu?.input ?? { faithfulness: 0, answer_relevancy: 0, context_relevancy: 0, notes: "no judge output" }) as {
    faithfulness: number;
    answer_relevancy: number;
    context_relevancy: number;
    notes: string;
  };
}

function hit(mustInclude: string[], passages: string): number {
  if (mustInclude.length === 0) return 1;
  const hay = new Set(tokenize(passages));
  const found = mustInclude.filter((m) => tokenize(m).every((t) => hay.has(t)));
  return found.length / mustInclude.length;
}

export interface EvalReport {
  game: string;
  cases: CaseResult[];
  agg: { faithfulness: number; answerRelevancy: number; contextRelevancy: number; retrievalHit: number };
}

export async function evaluate(game: string): Promise<EvalReport> {
  loadDotEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("eval needs ANTHROPIC_API_KEY (judge + answer generation)");

  const cases = JSON.parse(
    await readFile(join(import.meta.dirname, "eval-sets", `${game}.json`), "utf8"),
  ) as EvalCase[];

  const results: CaseResult[] = [];
  for (const c of cases) {
    const r = await ask(game, c.question);
    const ctxText = r.passages.map((p, i) => `[${i + 1}] ${indexText(p.chunk)}`).join("\n\n");
    const retrievalHit = hit(c.mustInclude, r.passages.map((p) => indexText(p.chunk)).join("\n"));
    const j = await judge(apiKey, game, c.question, r.answer ?? "", ctxText);
    const cr: CaseResult = {
      ...c,
      answer: r.answer ?? "",
      topScore: r.topScore,
      retrievalHit,
      faithfulness: j.faithfulness,
      answerRelevancy: j.answer_relevancy,
      contextRelevancy: j.context_relevancy,
    };
    results.push(cr);
    console.log(
      `  • ${c.question.slice(0, 54).padEnd(54)}  faith ${j.faithfulness.toFixed(2)}  rel ${j.answer_relevancy.toFixed(2)}  ctx ${j.context_relevancy.toFixed(2)}  hit ${retrievalHit.toFixed(2)}` +
        (j.notes ? `\n      ↳ ${j.notes}` : ""),
    );
  }

  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
  return {
    game,
    cases: results,
    agg: {
      faithfulness: mean(results.map((r) => r.faithfulness)),
      answerRelevancy: mean(results.map((r) => r.answerRelevancy)),
      contextRelevancy: mean(results.map((r) => r.contextRelevancy)),
      retrievalHit: mean(results.map((r) => r.retrievalHit)),
    },
  };
}
