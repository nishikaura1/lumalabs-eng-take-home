import http from "node:http";
import { config } from "./config.js";
import { migrate } from "./db/index.js";
import { bot } from "./telegram/bot.js";
import { startWorkerLoop } from "./worker.js";

async function main() {
  await migrate();
  console.log("[db] schema ready");

  // Minimal health-check surface for the host (Railway/Fly/etc). We use
  // Telegram long polling, not webhooks, so this is all the HTTP we need.
  http
    .createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    })
    .listen(config.port, () => console.log(`[http] health check on :${config.port}`));

  startWorkerLoop();

  await bot.start({
    onStart: () => console.log("[telegram] bot polling started"),
  });
}

main().catch((e) => {
  console.error("Fatal startup error:", e);
  process.exit(1);
});
