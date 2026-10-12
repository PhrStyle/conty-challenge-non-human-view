import { classify, type Classification } from "./classifier.ts";
import { CATEGORIES, HOURS, PER_CATEGORY, SEED, type Sample } from "./dataset.ts";

export interface CategoryRow {
  category: string;
  label: Sample["label"];
  hard: boolean;
  description: string;
  counts: Record<Classification, number>;
}

export interface Evaluation {
  rows: CategoryRow[];
  legit: Record<Classification, number> & { total: number };
  suspect: Record<Classification, number> & { total: number };
  /** Legítimo classificado como suspeito, dividido pelo total de legítimos. */
  falsePositiveRate: number;
}

const empty = (): Record<Classification, number> => ({ organico: 0, inconclusivo: 0, suspeito: 0 });

export function evaluate(samples: Sample[]): Evaluation {
  const rows = new Map<string, CategoryRow>();
  for (const c of CATEGORIES) {
    rows.set(c.name, { category: c.name, label: c.label, hard: c.hard, description: c.description, counts: empty() });
  }
  const legit = { ...empty(), total: 0 };
  const suspect = { ...empty(), total: 0 };
  for (const s of samples) {
    const got = classify(s.views).classification;
    rows.get(s.category)!.counts[got]++;
    const group = s.label === "legitimo" ? legit : suspect;
    group[got]++;
    group.total++;
  }
  return { rows: [...rows.values()], legit, suspect, falsePositiveRate: legit.suspeito / legit.total };
}

const percent = (part: number, total: number) =>
  `${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format((100 * part) / total)}%`;

/** Bloco que vai no README, entre os marcadores. O teste compara este texto com o README. */
export function renderReport(ev: Evaluation): string {
  const { legit, suspect } = ev;
  const lines = [
    `Semente ${SEED}, ${PER_CATEGORY} séries de ${HOURS}h por categoria, ${legit.total + suspect.total} séries no total.`,
    "",
    `**Taxa de falso positivo: ${percent(legit.suspeito, legit.total)}** (${legit.suspeito} de ${legit.total} séries legítimas classificadas como \`suspeito\`).`,
    "",
    `- Legítimas marcadas como \`inconclusivo\` (sem acusação): ${legit.inconclusivo} de ${legit.total} (${percent(legit.inconclusivo, legit.total)}).`,
    `- Suspeitas detectadas como \`suspeito\`: ${suspect.suspeito} de ${suspect.total} (${percent(suspect.suspeito, suspect.total)}); ` +
      `\`inconclusivo\`: ${suspect.inconclusivo}; passaram como \`organico\`: ${suspect.organico}.`,
    "",
    "| Categoria | Rótulo | Difícil | O que simula | organico | inconclusivo | suspeito |",
    "| --- | --- | --- | --- | ---: | ---: | ---: |",
    ...ev.rows.map(
      (r) =>
        `| \`${r.category}\` | ${r.label} | ${r.hard ? "sim" : "não"} | ${r.description} | ` +
        `${r.counts.organico} | ${r.counts.inconclusivo} | ${r.counts.suspeito} |`,
    ),
  ];
  return lines.join("\n");
}

export const REPORT_START = "<!-- avaliacao:inicio (gerado por npm run evaluate, não editar à mão) -->";
export const REPORT_END = "<!-- avaliacao:fim -->";

export function readReportBlock(readme: string): string | undefined {
  const start = readme.indexOf(REPORT_START);
  const end = readme.indexOf(REPORT_END);
  if (start < 0 || end < start) return undefined;
  return readme.slice(start + REPORT_START.length, end).trim();
}

export function replaceReportBlock(readme: string, report: string): string {
  const start = readme.indexOf(REPORT_START);
  const end = readme.indexOf(REPORT_END);
  if (start < 0 || end < start) throw new Error("marcadores da avaliação não encontrados no README");
  return `${readme.slice(0, start + REPORT_START.length)}\n${report}\n${readme.slice(end)}`;
}
