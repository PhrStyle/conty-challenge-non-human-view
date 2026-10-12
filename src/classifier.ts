export type Classification = "organico" | "suspeito" | "inconclusivo";
export type SignalId =
  | "degrau"
  | "plato"
  | "queda_abrupta"
  | "fora_do_horario"
  | "repeticao"
  | "sem_ciclo_diario"
  | "recorrencia";

export interface Signal {
  id: SignalId;
  label: string;
  hour: number;
  detail: string;
}

export interface ViewEvent {
  kind: "pico" | "repeticao";
  start_hour: number;
  end_hour: number;
  day: number;
  peak: number;
  baseline: number;
  signals: Signal[];
  classification: Classification;
  reason: string;
}

export interface ClassificationResult {
  classification: Classification;
  reason: string;
  /** Sinais que sustentam a classificação geral (vazio quando orgânico). */
  signals: Signal[];
  events: ViewEvent[];
  hours: number;
}

/** Todos os limites do critério. O README explica cada um. */
export const CRITERIA = {
  /** Abaixo disso não há base antes do pico nem dois ciclos de dia e noite. */
  minHours: 48,
  /** A base é a mediana das últimas 24 horas fora de pico. */
  baselineHours: 24,
  /** Uma hora entra em pico quando passa de 3x a base e de base + 300. */
  peakFactor: 3,
  peakMinExtra: 300,
  /** Degrau: uma hora com 4x a anterior que já chega a 70% do pico. */
  stepFactor: 4,
  stepPeakShare: 0.7,
  /** Trecho "plano": em toda janela de 5h, máximo e mínimo a até 5% da média, com média de pelo menos 50 views/h. */
  flatMaxVariation: 0.05,
  flatMinMean: 50,
  plateauMinHours: 5,
  repetitionMinHours: 6,
  noCycleMinHours: 24,
  /** Queda abrupta: perde 75% ou mais em uma hora, partindo de pelo menos metade do pico. */
  cliffDrop: 0.75,
  cliffFromPeakShare: 0.5,
  /**
   * Fora do horário do público: o pico começa numa das 6 horas do dia com menos audiência no ciclo do próprio
   * criador. Só reforça um pico que já tem outro sinal, e só vale se o ciclo for claro (hora mais ativa com 1,5x
   * a menos ativa).
   */
  offHours: 6,
  cycleMinRatio: 1.5,
  peakTailHours: 12,
  /** 3 eventos de um sinal com o mesmo intervalo entre eles (±3h, intervalo de pelo menos 12h) viram suspeito. */
  recurrenceCount: 3,
  recurrenceTolerance: 3,
  recurrenceMinPeriod: 12,
} as const;

const LABELS: Record<SignalId, string> = {
  degrau: "Subida em degrau",
  plato: "Platô",
  queda_abrupta: "Queda abrupta",
  fora_do_horario: "Fora do horário do público",
  repeticao: "Repetição mecânica",
  sem_ciclo_diario: "Sem ciclo de dia e noite",
  recorrencia: "Recorrência em intervalo fixo",
};

const num = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const pct = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const n = (v: number) => num.format(v);
const p = (ratio: number) => pct.format(ratio * 100);
const day = (hour: number) => Math.floor(hour / 24) + 1;
const hours = (start: number, end: number) => (start === end ? `na hora ${start}` : `nas horas ${start} a ${end}`);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function signal(id: SignalId, hour: number, detail: string): Signal {
  return { id, label: LABELS[id], hour, detail };
}

interface Peak {
  start: number;
  end: number;
  baseline: number;
  limit: number;
  peak: number;
}

/**
 * Picos: trechos em que as views passam do limite calculado sobre a base. A base é a mediana das últimas
 * 24 horas que não estavam em pico, então um pico não infla a base do próximo, e fica fixa enquanto o pico dura.
 */
function findPeaks(views: number[]): Peak[] {
  const initial = median(views.slice(0, CRITERIA.baselineHours));
  const quiet: number[] = [];
  const peaks: Peak[] = [];
  let t = 0;
  while (t < views.length) {
    const recent = quiet.slice(-CRITERIA.baselineHours);
    const baseline = recent.length >= CRITERIA.baselineHours / 2 ? median(recent) : initial;
    const limit = Math.max(baseline * CRITERIA.peakFactor, baseline + CRITERIA.peakMinExtra);
    if (views[t]! < limit) {
      quiet.push(views[t]!);
      t++;
      continue;
    }
    let end = t;
    while (end + 1 < views.length && views[end + 1]! >= limit) end++;
    peaks.push({ start: t, end, baseline, limit, peak: Math.max(...views.slice(t, end + 1)) });
    t = end + 1;
  }
  return peaks;
}

interface FlatRun {
  start: number;
  end: number;
  min: number;
  max: number;
  /** Maior variação entre as janelas de 5h do trecho. */
  worst: number;
}

/**
 * Trechos em que as views quase não variam: toda janela de 5 horas seguidas fica com máximo e mínimo a até 5%
 * da média dela. Janelas que se encostam viram um trecho só, então um fluxo constante de 30h não se quebra
 * em pedaços só porque o ruído acumulado em 30h passa de 5%.
 */
function findFlatRuns(views: number[]): FlatRun[] {
  const size = CRITERIA.plateauMinHours;
  const flat = (i: number) => {
    const w = views.slice(i, i + size);
    const mean = w.reduce((a, b) => a + b, 0) / size;
    return mean >= CRITERIA.flatMinMean && Math.max(...w) - Math.min(...w) <= CRITERIA.flatMaxVariation * mean;
  };
  const runs: FlatRun[] = [];
  let i = 0;
  while (i + size <= views.length) {
    if (!flat(i)) {
      i++;
      continue;
    }
    let last = i;
    while (last + 1 + size <= views.length && flat(last + 1)) last++;
    const values = views.slice(i, last + size);
    runs.push({
      start: i,
      end: last + size - 1,
      min: Math.min(...values),
      max: Math.max(...values),
      worst: Math.max(...Array.from({ length: last - i + 1 }, (_, k) => windowVariation(views, i + k, size))),
    });
    i = last + size;
  }
  return runs;
}

function windowVariation(views: number[], start: number, size: number): number {
  const w = views.slice(start, start + size);
  return (Math.max(...w) - Math.min(...w)) / (w.reduce((a, b) => a + b, 0) / size);
}

const runLength = (r: FlatRun) => r.end - r.start + 1;

function noCycle(run: FlatRun): Signal | undefined {
  const length = runLength(run);
  if (length < CRITERIA.noCycleMinHours) return undefined;
  return signal(
    "sem_ciclo_diario",
    run.start,
    `${length}h sem diferença entre dia e noite ${hours(run.start, run.end)}, e público real assiste menos de madrugada`,
  );
}

interface DailyCycle {
  /** Mediana das views em cada hora do dia (posição na série módulo 24), sem os picos e as 12h depois deles. */
  profile: (number | undefined)[];
  /** As horas do dia com menos audiência, ou vazio se o ciclo não é claro. */
  quietest: Set<number>;
}

function dailyCycle(views: number[], peaks: Peak[]): DailyCycle {
  // A cauda de um pico também infla as horas seguintes; quem posta todo dia pode não sobrar hora limpa e aí o
  // ciclo fica "não claro" e o sinal não é usado.
  const inPeak = (t: number) => peaks.some((pk) => t >= pk.start && t <= pk.end + CRITERIA.peakTailHours);
  const profile = Array.from({ length: 24 }, (_, hd) => {
    const values = views.filter((_, t) => t % 24 === hd && !inPeak(t));
    return values.length > 0 ? median(values) : undefined;
  });
  const known = profile.flatMap((v, hd) => (v === undefined ? [] : [{ hd, v }]));
  const low = Math.min(...known.map((k) => k.v));
  const high = Math.max(...known.map((k) => k.v));
  const clear = known.length === 24 && high >= CRITERIA.cycleMinRatio * Math.max(low, 1);
  const quietest = clear ? known.sort((a, b) => a.v - b.v || a.hd - b.hd).slice(0, CRITERIA.offHours) : [];
  return { profile, quietest: new Set(quietest.map((k) => k.hd)) };
}

function offHours(cycle: DailyCycle, hour: number): Signal | undefined {
  if (!cycle.quietest.has(hour % 24)) return undefined;
  const active = Math.max(...cycle.profile.map((v) => v ?? 0));
  return signal(
    "fora_do_horario",
    hour,
    `começou na hora ${hour}, que no ciclo deste criador está entre as ${CRITERIA.offHours} horas de menor audiência ` +
      `do dia (~${n(cycle.profile[hour % 24]!)} views/h, contra ~${n(active)} no horário mais ativo)`,
  );
}

function peakSignals(views: number[], peak: Peak, runs: FlatRun[], cycle: DailyCycle): Signal[] {
  const signals: Signal[] = [];

  for (let t = Math.max(peak.start, 1); t <= peak.end; t++) {
    const prev = views[t - 1]!;
    if (views[t]! >= CRITERIA.stepFactor * prev && views[t]! >= CRITERIA.stepPeakShare * peak.peak) {
      const ratio = prev > 0 ? ` (${pct.format(views[t]! / prev)}x)` : "";
      signals.push(
        signal("degrau", t, `saltou de ${n(prev)} para ${n(views[t]!)} views/h em uma hora${ratio} na hora ${t}, sem subida gradual`),
      );
      break;
    }
  }

  const plateau = runs
    .filter((r) => r.start <= peak.end && r.end >= peak.start && r.min >= peak.limit)
    .sort((a, b) => runLength(b) - runLength(a))[0];
  if (plateau) {
    signals.push(
      signal(
        "plato",
        plateau.start,
        `ficou ${runLength(plateau)}h seguidas entre ${n(plateau.min)} e ${n(plateau.max)} views/h ` +
          `${hours(plateau.start, plateau.end)}, sem variar mais de ${p(plateau.worst)}% em 5h, quando audiência real oscila`,
      ),
    );
    const cycle = noCycle(plateau);
    if (cycle) signals.push(cycle);
  }

  for (let t = peak.start + 1; t <= Math.min(peak.end + 1, views.length - 1); t++) {
    const prev = views[t - 1]!;
    if (views[t]! <= (1 - CRITERIA.cliffDrop) * prev && prev >= CRITERIA.cliffFromPeakShare * peak.peak) {
      signals.push(
        signal(
          "queda_abrupta",
          t,
          `caiu de ${n(prev)} para ${n(views[t]!)} views/h em uma hora na hora ${t} (-${p(1 - views[t]! / prev)}%)`,
        ),
      );
      break;
    }
  }

  if (signals.length > 0) {
    const late = offHours(cycle, signals.find((sg) => sg.id === "degrau")?.hour ?? peak.start);
    if (late) signals.push(late);
  }

  return signals.sort((a, b) => a.hour - b.hour);
}

function classOf(signals: Signal[]): Classification {
  if (signals.length >= 2) return "suspeito";
  return signals.length === 1 ? "inconclusivo" : "organico";
}

const VERDICT: Record<Classification, string> = {
  suspeito: "Audiência real não mostra esses sinais juntos.",
  inconclusivo:
    "Um sinal sozinho não basta para acusar: pode ser o algoritmo da plataforma, vídeo arquivado ou um compartilhamento grande.",
  organico: "",
};

function describePeak(views: number[], peak: Peak, signals: Signal[]): string {
  const where = `Pico de ${n(peak.peak)} views/h ${hours(peak.start, peak.end)} (dia ${day(peak.start)}), sobre uma base de ~${n(peak.baseline)}`;
  if (signals.length === 0) {
    const top = peak.start + views.slice(peak.start, peak.end + 1).indexOf(peak.peak);
    const rise = top - peak.start + 1;
    return `${where}: subiu em ${rise}h e desceu aos poucos, como audiência real.`;
  }
  return `${where}: ${signals.map((s) => s.detail).join("; ")}. ${VERDICT[classOf(signals)]}`;
}

function buildEvents(views: number[]): ViewEvent[] {
  const peaks = findPeaks(views);
  const runs = findFlatRuns(views);
  const cycle = dailyCycle(views, peaks);
  const events: ViewEvent[] = peaks.map((peak) => {
    const signals = peakSignals(views, peak, runs, cycle);
    return {
      kind: "pico",
      start_hour: peak.start,
      end_hour: peak.end,
      day: day(peak.start),
      peak: peak.peak,
      baseline: peak.baseline,
      signals,
      classification: classOf(signals),
      reason: describePeak(views, peak, signals),
    };
  });

  for (const run of runs) {
    const insidePeak = peaks.some((pk) => run.start <= pk.end && run.end >= pk.start);
    if (insidePeak || runLength(run) < CRITERIA.repetitionMinHours) continue;
    const signals = [
      signal(
        "repeticao",
        run.start,
        `${runLength(run)}h seguidas entre ${n(run.min)} e ${n(run.max)} views/h ${hours(run.start, run.end)}, ` +
          `sem variar mais de ${p(run.worst)}% em 5h e sem pico que explique`,
      ),
    ];
    const cycle = noCycle(run);
    if (cycle) signals.push(cycle);
    events.push({
      kind: "repeticao",
      start_hour: run.start,
      end_hour: run.end,
      day: day(run.start),
      peak: run.max,
      baseline: Math.round((run.min + run.max) / 2),
      signals,
      classification: classOf(signals),
      reason: `Views quase constantes: ${signals.map((s) => s.detail).join("; ")}. ${VERDICT[classOf(signals)]}`,
    });
  }

  return events.sort((a, b) => a.start_hour - b.start_hour);
}

/**
 * Recorrência: 3 eventos de um sinal só, separados pelo mesmo intervalo (24h e 24h, 48h e 48h...), com
 * tolerância de 3h. Devolve a sequência mais longa encontrada.
 */
function periodicRecurrence(events: ViewEvent[]): { chain: ViewEvent[]; period: number } | undefined {
  const single = events.filter((e) => e.signals.length === 1);
  const at = (e: ViewEvent) => e.signals[0]!.hour;
  let best: { chain: ViewEvent[]; period: number } | undefined;
  for (let i = 0; i < single.length; i++) {
    for (let j = i + 1; j < single.length; j++) {
      const period = at(single[j]!) - at(single[i]!);
      if (period < CRITERIA.recurrenceMinPeriod) continue;
      const chain = [single[i]!, single[j]!];
      for (const e of single.slice(j + 1)) {
        if (Math.abs(at(e) - at(chain.at(-1)!) - period) <= CRITERIA.recurrenceTolerance) chain.push(e);
      }
      if (chain.length >= CRITERIA.recurrenceCount && chain.length > (best?.chain.length ?? 0)) best = { chain, period };
    }
  }
  return best;
}

const list = (items: number[]) =>
  items.length === 1 ? String(items[0]) : `${items.slice(0, -1).join(", ")} e ${items.at(-1)}`;

export function classify(views: number[]): ClassificationResult {
  const total = views.length;
  if (total < CRITERIA.minHours) {
    return {
      classification: "inconclusivo",
      reason:
        `Inconclusivo. A série tem ${total}h e o mínimo é ${CRITERIA.minHours}h: com menos que isso não há ` +
        "uma base antes do pico nem dois ciclos de dia e noite para comparar.",
      signals: [],
      events: [],
      hours: total,
    };
  }

  const events = buildEvents(views);
  const suspicious = events.filter((e) => e.classification === "suspeito");
  if (suspicious.length > 0) {
    return {
      classification: "suspeito",
      reason: `Suspeito. ${suspicious.map((e) => e.reason).join(" ")}`,
      signals: suspicious.flatMap((e) => e.signals),
      events,
      hours: total,
    };
  }

  const recurring = periodicRecurrence(events);
  if (recurring) {
    const { chain, period } = recurring;
    const detail =
      `${chain.length} eventos com um sinal cada, a cada ~${period}h: ` +
      chain.map((e) => `${e.signals[0]!.label.toLowerCase()} na hora ${e.signals[0]!.hour}`).join(", ");
    return {
      classification: "suspeito",
      reason:
        `Suspeito. A mesma anomalia volta em intervalo fixo: ${detail}. Uma vez pode ser o algoritmo; ` +
        "repetida no mesmo ritmo parece entrega programada.",
      signals: [signal("recorrencia", chain[0]!.signals[0]!.hour, detail), ...chain.flatMap((e) => e.signals)],
      events,
      hours: total,
    };
  }

  const doubtful = events.filter((e) => e.classification === "inconclusivo");
  if (doubtful.length > 0) {
    const spread =
      doubtful.length > 1
        ? ` São ${doubtful.length} eventos isolados (dias ${list([...new Set(doubtful.map((e) => e.day))])}), ` +
          "sem intervalo fixo entre eles."
        : "";
    return {
      classification: "inconclusivo",
      reason: `Inconclusivo. ${doubtful.map((e) => e.reason).join(" ")}${spread}`,
      signals: doubtful.flatMap((e) => e.signals),
      events,
      hours: total,
    };
  }

  const biggest = [...events].sort((a, b) => b.peak - a.peak)[0];
  return {
    classification: "organico",
    reason: `Orgânico. Nenhum sinal de view comprada em ${total}h.${biggest ? ` ${biggest.reason}` : ""}`,
    signals: [],
    events,
    hours: total,
  };
}
