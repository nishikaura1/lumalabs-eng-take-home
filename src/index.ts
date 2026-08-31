import http from "node:http";
import { TelegramChatAdapter } from "./chat/telegram.js";
import { wireChatAdapter } from "./chat/orchestrator.js";
import { startNotifierLoop } from "./chat/notifier.js";
import { config } from "./config.js";
import { migrate, reclaimStuckGenerating } from "./db/index.js";
import { startWorkerLoop } from "./worker.js";

async function main() {
  await migrate();
  console.log("[db] schema ready");

  // Every boot, not just recovery from a crash — a normal redeploy kills
  // the process mid-flight just as easily. See reclaimStuckGenerating's
  // doc comment; found live on a real Railway redeploy.
  const reclaimed = await reclaimStuckGenerating();
  if (reclaimed > 0) {
    console.log(`[db] reclaimed ${reclaimed} product(s) stuck in 'generating' from a prior run`);
  }

  // Minimal health-check surface for the host (Railway/Fly/etc). We use
  // Telegram long polling, not webhooks, so this is all the HTTP we need.
  http
    .createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    })
    .listen(config.port, () => console.log(`[http] health check on :${config.port}`));

  // The only place a concrete ChatAdapter is constructed. Everything else
  // (worker, notifier, orchestrator) depends on the ChatAdapter interface,
  // not on Telegram specifically — swapping this one line is what "runs
  // universally" actually means in practice. See src/chat/types.ts and
  // docs/chat-adapter-proposals/SYNTHESIS.md.
  const adapter = new TelegramChatAdapter({
    botToken: config.telegram.botToken,
    chatId: config.telegram.chatId,
  });

  wireChatAdapter(adapter);
  startWorkerLoop(adapter);
  startNotifierLoop(adapter);

  await adapter.start();
  console.log("[chat] adapter started (telegram)");
}

main().catch((e) => {
  console.error("Fatal startup error:", e);
  process.exit(1);
});
