import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3005);

serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`classificador de views em http://127.0.0.1:${info.port}`);
});
