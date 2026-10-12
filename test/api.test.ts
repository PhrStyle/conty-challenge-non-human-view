import { describe, expect, it } from "vitest";
import { createApp, MAX_HOURS } from "../src/app.ts";

async function post(body: string) {
  const res = await createApp().request("/classify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("API", () => {
  it("devolve classificação, motivo, sinais e eventos", async () => {
    const views = Array.from({ length: 72 }, (_, h) => (h >= 30 && h < 36 ? 10_000 : 200 + (h % 24) * 10));
    const { status, body } = await post(JSON.stringify({ views }));
    expect(status).toBe(200);
    expect(body).toMatchObject({ classification: "suspeito", hours: 72 });
    expect(typeof body.reason).toBe("string");
    expect(body.signals.map((s: any) => s.id)).toEqual(["degrau", "plato", "queda_abrupta"]);
    expect(body.signals[0]).toEqual({
      id: "degrau",
      label: "Subida em degrau",
      hour: 30,
      detail: expect.stringContaining("saltou de"),
    });
    expect(body.events[0]).toMatchObject({ kind: "pico", start_hour: 30, end_hour: 35, day: 2, peak: 10_000 });
  });

  it("série curta é 200 inconclusivo, não erro", async () => {
    const { status, body } = await post(JSON.stringify({ views: [1, 2, 3] }));
    expect(status).toBe(200);
    expect(body.classification).toBe("inconclusivo");
  });

  it.each([
    ["JSON inválido", "{", "JSON"],
    ["sem views", "{}", '{"views": [...]}'],
    ["lista solta", "[1,2,3]", '{"views": [...]}'],
    ["negativo", '{"views":[1,-2]}', "views[1]"],
    ["fracionado", '{"views":[1.5]}', "views[0]"],
    ["texto", '{"views":["10"]}', "views[0]"],
    ["longa demais", JSON.stringify({ views: Array(MAX_HOURS + 1).fill(1) }), "no máximo"],
  ])("422 para %s", async (_, body, message) => {
    const res = await post(body);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("validation");
    expect(res.body.message).toContain(message);
  });
});
