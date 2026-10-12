import { Hono } from "hono";
import { classify } from "./classifier.ts";
import { DomainError } from "./errors.ts";

/** 90 dias de série por hora. */
export const MAX_HOURS = 24 * 90;

function parseViews(body: unknown): number[] {
  const views = body && typeof body === "object" && !Array.isArray(body) ? (body as { views?: unknown }).views : undefined;
  if (!Array.isArray(views)) {
    throw new DomainError("validation", 'o corpo deve ser {"views": [...]}, uma lista com as views de cada hora');
  }
  if (views.length > MAX_HOURS) {
    throw new DomainError("validation", `views aceita no máximo ${MAX_HOURS} horas (90 dias), recebeu ${views.length}`);
  }
  const bad = views.findIndex((v) => typeof v !== "number" || !Number.isSafeInteger(v) || v < 0);
  if (bad >= 0) {
    throw new DomainError("validation", `views[${bad}] deve ser um inteiro maior ou igual a zero (views daquela hora)`);
  }
  return views as number[];
}

export function createApp() {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof DomainError) return c.json({ error: err.code, message: err.message }, 422);
    console.error(err);
    return c.json({ error: "internal", message: "erro interno" }, 500);
  });

  app.post("/classify", async (c) => {
    const body: unknown = await c.req.json().catch(() => {
      throw new DomainError("validation", "o corpo deve ser JSON");
    });
    return c.json(classify(parseViews(body)));
  });

  return app;
}
