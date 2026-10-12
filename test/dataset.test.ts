import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATEGORIES, generateDataset, HOURS, PER_CATEGORY, toJsonl } from "../src/dataset.ts";
import { evaluate, readReportBlock, renderReport } from "../src/evaluate.ts";

const root = new URL("..", import.meta.url);
const dataset = generateDataset();

describe("dataset sintético", () => {
  it("a mesma semente gera exatamente as mesmas séries; outra semente gera outras", () => {
    expect(generateDataset()).toEqual(dataset);
    expect(generateDataset(1)).not.toEqual(dataset);
  });

  it("tem casos legítimos e suspeitos, todos com séries de 168h de inteiros não negativos", () => {
    expect(dataset).toHaveLength(CATEGORIES.length * PER_CATEGORY);
    expect(new Set(dataset.map((s) => s.label))).toEqual(new Set(["legitimo", "suspeito"]));
    for (const s of dataset) {
      expect(s.views).toHaveLength(HOURS);
      expect(s.views.every((v) => Number.isSafeInteger(v) && v >= 0)).toBe(true);
    }
  });

  it("data/dataset.jsonl é o que o gerador produz (rode npm run evaluate se falhar)", () => {
    expect(readFileSync(new URL("data/dataset.jsonl", root), "utf8")).toBe(toJsonl(dataset));
  });
});

describe("README", () => {
  const readme = readFileSync(new URL("README.md", root), "utf8");
  const measured = evaluate(dataset);

  it("a taxa de falso positivo do README é a medida (rode npm run evaluate -- --write-readme se falhar)", () => {
    const written = readme.match(/Taxa de falso positivo: ([\d,]+)%/)?.[1];
    const rate = (100 * measured.falsePositiveRate).toFixed(1).replace(".", ",");
    expect(written).toBe(rate);
  });

  it("o bloco de avaliação inteiro do README é o que o comando gera", () => {
    expect(readReportBlock(readme)).toBe(renderReport(measured));
  });
});
