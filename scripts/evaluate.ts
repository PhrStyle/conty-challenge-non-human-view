/**
 * Gera o dataset sintético em data/dataset.jsonl, classifica cada série e imprime a taxa de falso positivo.
 * Com --write-readme, também atualiza o bloco de avaliação do README.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { generateDataset, toJsonl } from "../src/dataset.ts";
import { evaluate, renderReport, replaceReportBlock } from "../src/evaluate.ts";

const root = new URL("..", import.meta.url);
const samples = generateDataset();
writeFileSync(new URL("data/dataset.jsonl", root), toJsonl(samples));

const report = renderReport(evaluate(samples));
console.log(report);

if (process.argv.includes("--write-readme")) {
  const path = new URL("README.md", root);
  writeFileSync(path, replaceReportBlock(readFileSync(path, "utf8"), report));
  console.log("\nREADME atualizado.");
}
