import { describe, expect, it } from "vitest";
import { classify } from "../src/classifier.ts";
import { Rng } from "../src/dataset.ts";

const HOURS = 168;

/** Audiência real: ciclo de dia e noite (metade da base de madrugada, 1,5x à tarde) e ~10% de ruído. */
function audience(base: number, seed = 1, hours = HOURS): number[] {
  const rng = new Rng(seed);
  return Array.from({ length: hours }, (_, h) =>
    Math.round(base * (1 + 0.5 * Math.sin((2 * Math.PI * h) / 24)) * (1 + 0.1 * rng.normal())),
  );
}

/** Soma um extra hora a hora a partir de `start`. */
function add(views: number[], start: number, extra: number[]): number[] {
  return views.map((v, h) => v + (h >= start && h - start < extra.length ? extra[h - start]! : 0));
}

/** Viral orgânico de 10 mil views/h: sobe em 4h e perde metade a cada 12h. */
const organicViral = Array.from({ length: 96 }, (_, k) => Math.round(k < 4 ? 10_000 * ((k + 1) / 4) ** 2 : 10_000 * 0.5 ** ((k - 3) / 12)));
/** Compra de 10 mil views/h por 6h, entregue quase igual toda hora. */
const boughtBlock = [10_010, 9_980, 10_050, 10_000, 9_990, 10_020];

const ids = (signals: { id: string }[]) => signals.map((s) => s.id);

describe("classificador", () => {
  it("audiência estável com ciclo de dia e noite é orgânica e sem sinais", () => {
    const result = classify(audience(1_000));
    expect(result).toMatchObject({ classification: "organico", signals: [], events: [] });
    expect(result.reason).toContain("Nenhum sinal de view comprada em 168h");
  });

  it("pico orgânico e pico comprado do mesmo tamanho caem em baldes diferentes", () => {
    const viral = classify(add(audience(300), 72, organicViral));
    const bought = classify(add(audience(300), 72, boughtBlock));

    expect(viral.classification).toBe("organico");
    expect(viral.events).toHaveLength(1);
    expect(viral.events[0]).toMatchObject({ kind: "pico", classification: "organico", signals: [] });
    expect(viral.events[0]!.peak).toBeGreaterThan(9_000);
    expect(viral.reason).toMatch(/subiu em \d+h e desceu aos poucos/);

    expect(bought.classification).toBe("suspeito");
    expect(ids(bought.signals)).toEqual(["degrau", "plato", "queda_abrupta"]);
    expect(bought.events[0]).toMatchObject({ start_hour: 72, end_hour: 77, classification: "suspeito" });
    expect(bought.reason).toContain("sem subida gradual");
    expect(bought.reason).toContain("ficou 6h seguidas");
    expect(bought.reason).toMatch(/caiu de [\d.]+ para [\d.]+ views\/h em uma hora/);
  });

  it("prefere não acusar: viral que some de uma hora para outra (arquivado ou cortado pelo algoritmo)", () => {
    const archived = organicViral.slice(0, 10).concat(Array(86).fill(-250));
    const result = classify(add(audience(300), 72, archived));
    expect(result.classification).toBe("inconclusivo");
    expect(ids(result.signals)).toEqual(["queda_abrupta"]);
    expect(result.reason).toContain("Um sinal sozinho não basta para acusar");
  });

  it("viral que chega ao pico em 1h (perfil grande compartilhou) também não é acusado", () => {
    const shared = Array.from({ length: 96 }, (_, k) => Math.round(10_000 * 0.5 ** (k / 12)));
    const result = classify(add(audience(300), 72, shared));
    expect(result.classification).toBe("inconclusivo");
    expect(ids(result.signals)).toEqual(["degrau"]);
  });

  it("views constantes o dia inteiro, inclusive de madrugada, são repetição mecânica", () => {
    const rng = new Rng(7);
    const bot = Array.from({ length: HOURS }, () => 500 + Math.round(2 * rng.normal()));
    const result = classify(bot);
    expect(result.classification).toBe("suspeito");
    expect(ids(result.signals)).toEqual(["repeticao", "sem_ciclo_diario"]);
    expect(result.reason).toContain("sem diferença entre dia e noite");
  });

  describe("fora do horário do público", () => {
    // No ciclo de audience(), a hora do dia 18 é a de menor audiência e a 6 é a de maior.
    const jump = [10_000, 7_000, 5_000, 3_500, 2_500, 1_800, 1_200];

    it("o mesmo degrau isolado é inconclusivo com o público ativo e suspeito na madrugada dele", () => {
      const day = classify(add(audience(300), 78, jump));
      const night = classify(add(audience(300), 90, jump));
      expect(day.classification).toBe("inconclusivo");
      expect(ids(day.signals)).toEqual(["degrau"]);
      expect(night.classification).toBe("suspeito");
      expect(ids(night.signals)).toEqual(["degrau", "fora_do_horario"]);
      expect(night.reason).toContain("entre as 6 horas de menor audiência do dia");
    });

    it("sozinho não é sinal: viral orgânico que começa de madrugada continua orgânico", () => {
      expect(classify(add(audience(300), 88, organicViral)).classification).toBe("organico");
    });
  });

  describe("recorrência", () => {
    /** Empurrão que chega de uma vez a 4 mil views/h e decai rápido, com o público ativo: um sinal só (degrau). */
    const push = [4_000, 2_800, 2_000, 1_400, 1_000, 700];
    const withPushes = (hours: number[]) => hours.reduce((v, h) => add(v, h, push), audience(300));

    it("o mesmo sinal a cada 24h, três vezes, é suspeito", () => {
      const result = classify(withPushes([30, 54, 78]));
      expect(result.classification).toBe("suspeito");
      expect(result.signals[0]).toMatchObject({ id: "recorrencia", hour: 30 });
      expect(result.reason).toContain("a cada ~24h");
    });

    it("também vale para outro intervalo fixo, como 48h", () => {
      const result = classify(withPushes([6, 54, 103]));
      expect(result.classification).toBe("suspeito");
      expect(result.reason).toContain("a cada ~48h");
    });

    it("os mesmos sinais sem intervalo fixo ficam inconclusivos", () => {
      const result = classify(withPushes([30, 57, 128]));
      expect(result.classification).toBe("inconclusivo");
      expect(result.events.filter((e) => e.signals.length === 1)).toHaveLength(3);
      expect(result.reason).toContain("sem intervalo fixo entre eles");
    });
  });

  it("série com menos de 48h é inconclusiva sem analisar", () => {
    const result = classify(add(audience(300, 1, 30), 10, boughtBlock));
    expect(result).toMatchObject({ classification: "inconclusivo", signals: [], events: [], hours: 30 });
    expect(result.reason).toContain("o mínimo é 48h");
  });

  it("o motivo é texto corrido, sem nomes internos de sinal", () => {
    const reasons = [
      classify(add(audience(300), 72, boughtBlock)).reason,
      classify(Array(HOURS).fill(500)).reason,
      classify(add(audience(300), 72, organicViral)).reason,
    ];
    for (const reason of reasons) expect(reason).not.toMatch(/[a-z]+_[a-z]+/);
  });
});
