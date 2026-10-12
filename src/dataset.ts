/**
 * Dataset sintético de séries de views por hora. Tudo sai de um PRNG com semente fixa, então a mesma
 * semente gera exatamente as mesmas séries em qualquer máquina, sem rede e sem dado de rede social.
 */

export type Label = "legitimo" | "suspeito";

export interface Sample {
  id: string;
  category: string;
  label: Label;
  views: number[];
}

export interface Category {
  name: string;
  label: Label;
  /** Caso difícil: feito para chegar perto da fronteira do critério. */
  hard: boolean;
  description: string;
  make: (rng: Rng) => number[];
}

export const SEED = 20261012;
export const PER_CATEGORY = 40;
export const HOURS = 168;

export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  /** mulberry32 */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniform(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  logUniform(a: number, b: number): number {
    return Math.exp(this.uniform(Math.log(a), Math.log(b)));
  }
  normal(): number {
    const u = 1 - this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda > 50) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * this.normal()));
    const limit = Math.exp(-lambda);
    let k = 0;
    let prod = this.next();
    while (prod > limit) {
      k++;
      prod *= this.next();
    }
    return k;
  }
}

/** Audiência real: contagem de Poisson sobre uma média que ainda oscila ~15% de hora em hora. */
const audience = (rng: Rng, lambda: number) => rng.poisson(lambda * Math.exp(0.15 * rng.normal() - 0.01125));

/** Bot: entrega quase exata do volume contratado (variação ~1%). */
const bought = (rng: Rng, volume: number, jitter = 0.01) => Math.max(0, Math.round(volume * (1 + jitter * rng.normal())));

interface Rhythm {
  base: number;
  /** Fator de dia e noite na hora h: 1 + A·sen(...). Madrugada fica em 1 - A. */
  cycle: (h: number) => number;
}

/**
 * Uma hora do dia `day` em que o público do criador está acordado (metade ativa do ciclo). Premissa do
 * dataset: quem posta com regularidade, e o conteúdo que decola sozinho, começam com o público ativo.
 */
function activeHour(rng: Rng, r: Rhythm, day: number): number {
  for (;;) {
    const h = 24 * day + rng.int(0, 23);
    if (r.cycle(h) >= 1) return h;
  }
}

function rhythm(rng: Rng, base = rng.logUniform(100, 3000)): Rhythm {
  const amplitude = rng.uniform(0.35, 0.65);
  const phase = rng.uniform(0, 24);
  return { base, cycle: (h) => 1 + amplitude * Math.sin((2 * Math.PI * (h + phase)) / 24) };
}

/** Post que viraliza: sobe em `rise` horas (curva quadrática) e decai pela metade a cada `halfLife` horas. */
function post(start: number, rise: number, height: number, halfLife: number) {
  return (h: number) => {
    if (h < start) return 0;
    if (h < start + rise) return height * ((h - start + 1) / rise) ** 2;
    return height * 0.5 ** ((h - start - rise + 1) / halfLife);
  };
}

const series = (fn: (h: number) => number) => Array.from({ length: HOURS }, (_, h) => fn(h));

function steady(rng: Rng, r = rhythm(rng)) {
  return series((h) => audience(rng, r.base * r.cycle(h)));
}

function viral(rng: Rng, rise: number, start?: (r: Rhythm) => number) {
  const r = rhythm(rng);
  const at = start ? start(r) : activeHour(rng, r, rng.int(1, 4));
  const boost = post(at, rise, r.base * rng.uniform(15, 60), rng.uniform(8, 24));
  return { r, boost, lambda: (h: number) => (r.base + boost(h)) * r.cycle(h) };
}

export const CATEGORIES: Category[] = [
  {
    name: "estavel",
    label: "legitimo",
    hard: false,
    description: "audiência constante com ciclo de dia e noite",
    make: (rng) => steady(rng),
  },
  {
    name: "viral_organico",
    label: "legitimo",
    hard: false,
    description: "viraliza: sobe em 3 a 6h até 15-60x a base e decai devagar (meia-vida de 8 a 24h)",
    make: (rng) => {
      const v = viral(rng, rng.int(3, 6));
      return series((h) => audience(rng, v.lambda(h)));
    },
  },
  {
    name: "viral_compartilhado",
    label: "legitimo",
    hard: true,
    description: "perfil grande compartilha: o pico chega em 1h (degrau), em qualquer hora do dia, e decai devagar",
    make: (rng) => {
      const v = viral(rng, 1, () => rng.int(24, 110));
      return series((h) => audience(rng, v.lambda(h)));
    },
  },
  {
    name: "viral_interrompido",
    label: "legitimo",
    hard: true,
    description: "viraliza e é arquivado ou perde alcance no algoritmo: as views caem para 5-20% de uma hora para outra",
    make: (rng) => {
      const r = rhythm(rng);
      const start = activeHour(rng, r, rng.int(1, 4));
      const rise = rng.int(3, 6);
      const boost = post(start, rise, r.base * rng.uniform(15, 60), rng.uniform(8, 24));
      const cut = start + rise + rng.int(2, 24);
      const kept = rng.uniform(0.05, 0.2);
      return series((h) => audience(rng, (r.base + boost(h)) * r.cycle(h) * (h >= cut ? kept : 1)));
    },
  },
  {
    name: "criador_pequeno",
    label: "legitimo",
    hard: true,
    description: "2 a 15 views/h, muitas horas zeradas e 2 a 4 posts que sobem em 1-2h e somem em poucas horas",
    make: (rng) => {
      const r = rhythm(rng, rng.uniform(2, 15));
      const posts = Array.from({ length: rng.int(2, 4) }, () =>
        post(activeHour(rng, r, rng.int(0, 6)), rng.int(1, 2), rng.uniform(300, 1500), rng.uniform(1, 3)),
      );
      return series((h) => audience(rng, r.base * r.cycle(h) + posts.reduce((s, f) => s + f(h), 0)));
    },
  },
  {
    name: "postador_diario",
    label: "legitimo",
    hard: true,
    description: "posta todo dia no mesmo horário, com o público ativo: cada post sobe em 1 a 3h até 4-12x a base",
    make: (rng) => {
      const r = rhythm(rng);
      const hour = activeHour(rng, r, 0);
      const posts = Array.from({ length: 6 }, (_, d) =>
        post(24 * (d + 1) + hour + rng.int(-1, 1), rng.int(1, 3), r.base * rng.uniform(4, 12), rng.uniform(3, 8)),
      );
      return series((h) => audience(rng, r.base * r.cycle(h) + posts.reduce((s, f) => s + f(h), 0)));
    },
  },
  {
    name: "postador_diario_instantaneo",
    label: "legitimo",
    hard: true,
    description: "posta todo dia no mesmo horário, com o público ativo, e cada post chega ao pico na 1ª hora: só com views, igual a `gotas_diarias`",
    make: (rng) => {
      const r = rhythm(rng);
      const hour = activeHour(rng, r, 0);
      const posts = Array.from({ length: 6 }, (_, d) =>
        post(24 * (d + 1) + hour + rng.int(-1, 1), 1, r.base * rng.uniform(4, 12), rng.uniform(3, 8)),
      );
      return series((h) => audience(rng, r.base * r.cycle(h) + posts.reduce((s, f) => s + f(h), 0)));
    },
  },
  {
    name: "pico_comprado",
    label: "suspeito",
    hard: false,
    description: "bloco de 3 a 10h com 10-80x a base, entregue quase constante, que começa e termina de uma vez",
    make: (rng) => {
      const r = rhythm(rng);
      const start = rng.int(24, 140);
      const length = rng.int(3, 10);
      const volume = r.base * rng.uniform(10, 80);
      return series((h) => audience(rng, r.base * r.cycle(h)) + (h >= start && h < start + length ? bought(rng, volume) : 0));
    },
  },
  {
    name: "compra_sobre_viral",
    label: "suspeito",
    hard: false,
    description: "viral orgânico com um bloco comprado de 4-8x o volume do momento, enxertado na descida",
    make: (rng) => {
      const v = viral(rng, rng.int(3, 6));
      const curve = series(v.boost);
      const top = curve.indexOf(Math.max(...curve));
      const start = Math.min(top + rng.int(4, 20), HOURS - 12);
      const length = rng.int(3, 8);
      const volume = v.lambda(start) * rng.uniform(4, 8);
      return series((h) => audience(rng, v.lambda(h)) + (h >= start && h < start + length ? bought(rng, volume) : 0));
    },
  },
  {
    name: "repeticao_mecanica",
    label: "suspeito",
    hard: false,
    description: "conta pequena com fluxo de bot quase constante (30-100x a base, mínimo 500 views/h) por 36h ou mais",
    make: (rng) => {
      const r = rhythm(rng, rng.uniform(5, 30));
      const start = rng.int(0, 60);
      const end = start + rng.int(36, HOURS - start);
      const volume = Math.max(500, r.base * rng.uniform(30, 100));
      return series((h) => audience(rng, r.base * r.cycle(h)) + (h >= start && h < end ? bought(rng, volume, 0.004) : 0));
    },
  },
  {
    name: "gotas_diarias",
    label: "suspeito",
    hard: false,
    description: "3 a 5 dias seguidos com um empurrão no mesmo horário: chega de uma vez a 8-25x a base e decai rápido",
    make: (rng) => {
      const r = rhythm(rng);
      const days = rng.int(3, 5);
      const first = rng.int(1, 7 - days);
      const hour = rng.int(0, 23);
      const pushes = Array.from({ length: days }, (_, d) =>
        post(24 * (first + d) + hour, 1, r.base * rng.uniform(8, 25), rng.uniform(1.5, 3)),
      );
      return series(
        (h) => audience(rng, r.base * r.cycle(h)) + bought(rng, pushes.reduce((s, f) => s + f(h), 0)),
      );
    },
  },
  {
    name: "compra_disfarcada",
    label: "suspeito",
    hard: true,
    description: "compra que imita viral: sobe em 3 a 5h e decai devagar, sem platô nem queda brusca",
    make: (rng) => {
      const r = rhythm(rng);
      const boost = post(rng.int(24, 110), rng.int(3, 5), r.base * rng.uniform(15, 60), rng.uniform(6, 16));
      return series((h) => audience(rng, r.base * r.cycle(h)) + bought(rng, boost(h), 0.05));
    },
  },
];

export function generateDataset(seed = SEED, perCategory = PER_CATEGORY): Sample[] {
  const rng = new Rng(seed);
  return CATEGORIES.flatMap((c) =>
    Array.from({ length: perCategory }, (_, i) => ({
      id: `${c.name}-${String(i + 1).padStart(3, "0")}`,
      category: c.name,
      label: c.label,
      views: c.make(rng),
    })),
  );
}

/** Uma série por linha (JSONL), na ordem de geração. */
export function toJsonl(samples: Sample[]): string {
  return samples.map((s) => JSON.stringify(s)).join("\n") + "\n";
}
