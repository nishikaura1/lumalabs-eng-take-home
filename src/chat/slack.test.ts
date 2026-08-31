/**
 * Tests for the Slack ChatAdapter, scoped to what's testable without a live
 * Slack workspace (none is available in this environment):
 *
 *   1. The value/action encode-decode scheme (slack-blocks.ts).
 *   2. The ShotState -> Block Kit mapping (slack-blocks.ts, pure functions).
 *   3. The ack-then-dispatch ordering (slack.ts), using a hand-rolled
 *      Bolt-shaped fake — real @slack/bolt isn't installed in this repo yet
 *      (see report to coordinator) and, even if it were, its `App` wants a
 *      live HTTP receiver and isn't practically unit-mockable in isolation.
 *
 * #3 is the most important test here: it's the direct executable proof of
 * this proposal's central finding (docs/chat-adapter-proposals/slack.md,
 * §3; also now the ChatAdapter interface's hard rule, types.ts) — that the
 * registered handler must never begin running until *after* the platform
 * ack has already gone out.
 *
 * Run with: npx tsx --test src/chat/slack.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { RejectReason, ShotState } from "./types.js";
import {
  buildGeneratedShotBlocks,
  buildMessageRef,
  decodeDecisionValue,
  encodeDecisionValue,
  parseMessageRef,
  SHOT_ACTION_ID,
  shotStateToBlocks,
} from "./slack-blocks.js";
import type { BoltActionArgs, BoltAppLike, BoltCommandArgs, BoltEventArgs } from "./slack.js";
import { SlackChatAdapter } from "./slack.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 1. Decision value encode/decode
// ---------------------------------------------------------------------------

test("encodeDecisionValue / decodeDecisionValue round-trip: approve", () => {
  const value = encodeDecisionValue("approve", 42);
  assert.equal(value, "approve:42");
  assert.deepStrictEqual(decodeDecisionValue(value), {
    action: "approve",
    generationId: 42,
    reasonCode: undefined,
  });
});

test("encodeDecisionValue / decodeDecisionValue round-trip: reject_reason carries the reason code", () => {
  const value = encodeDecisionValue("reject_reason", 42, "staged");
  assert.equal(value, "reject_reason:42:staged");
  assert.deepStrictEqual(decodeDecisionValue(value), {
    action: "reject_reason",
    generationId: 42,
    reasonCode: "staged",
  });
});

test("encodeDecisionValue / decodeDecisionValue round-trip: reject and undo", () => {
  assert.deepStrictEqual(decodeDecisionValue(encodeDecisionValue("reject", 7)), {
    action: "reject",
    generationId: 7,
    reasonCode: undefined,
  });
  assert.deepStrictEqual(decodeDecisionValue(encodeDecisionValue("undo", 7)), {
    action: "undo",
    generationId: 7,
    reasonCode: undefined,
  });
});

test("decodeDecisionValue rejects unrecognized actions", () => {
  assert.equal(decodeDecisionValue("delete:42"), null);
  assert.equal(decodeDecisionValue(""), null);
  assert.equal(decodeDecisionValue(":42"), null);
});

test("decodeDecisionValue rejects a non-numeric or malformed generationId", () => {
  assert.equal(decodeDecisionValue("approve:not-a-number"), null);
  assert.equal(decodeDecisionValue("approve:"), null);
  assert.equal(decodeDecisionValue("approve"), null);
});

test("decodeDecisionValue rejects reject_reason with no reason code, and non-reject_reason with an extra segment", () => {
  assert.equal(decodeDecisionValue("reject_reason:42"), null);
  assert.equal(decodeDecisionValue("approve:42:staged"), null);
});

test("decodeDecisionValue rejects a value with too many segments", () => {
  assert.equal(decodeDecisionValue("approve:42:staged:extra"), null);
});

// ---------------------------------------------------------------------------
// MessageRef encode/decode
// ---------------------------------------------------------------------------

test("buildMessageRef / parseMessageRef round-trip for a shot message (carries generationId)", () => {
  const ref = buildMessageRef("C0123ABC", "1700000000.000100", 42);
  assert.equal(ref, "C0123ABC:1700000000.000100:42");
  assert.deepStrictEqual(parseMessageRef(ref), {
    channel: "C0123ABC",
    ts: "1700000000.000100",
    generationId: 42,
  });
});

test("buildMessageRef / parseMessageRef round-trip for a plain text message (no generationId)", () => {
  const ref = buildMessageRef("C0123ABC", "1700000000.000100");
  assert.equal(ref, "C0123ABC:1700000000.000100");
  const parsed = parseMessageRef(ref);
  assert.ok(parsed);
  assert.equal(parsed?.channel, "C0123ABC");
  assert.equal(parsed?.ts, "1700000000.000100");
  assert.equal(parsed?.generationId, undefined);
});

test("parseMessageRef rejects garbage", () => {
  assert.equal(parseMessageRef(""), null);
  assert.equal(parseMessageRef("just-one-part"), null);
  assert.equal(parseMessageRef("a:b:not-a-number"), null);
  assert.equal(parseMessageRef("a:b:c:d"), null);
});

// ---------------------------------------------------------------------------
// 2. ShotState -> Block Kit mapping
// ---------------------------------------------------------------------------

const REASONS: RejectReason[] = [
  { code: "staged", label: "too staged" },
  { code: "light", label: "lighting/mood off" },
];

test("shotStateToBlocks: 'decide' renders Approve/Reject with the shared action_id", () => {
  const state: ShotState = { kind: "decide" };
  const blocks = shotStateToBlocks(42, { sku: "HG-002", variantIndex: 1 }, state);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, "section");
  assert.match((blocks[0] as any).text.text, /HG-002/);
  assert.equal(blocks[1].type, "actions");
  const elements = (blocks[1] as any).elements;
  assert.equal(elements.length, 2);
  for (const el of elements) assert.equal(el.action_id, SHOT_ACTION_ID);
  assert.deepStrictEqual(
    elements.map((e: any) => e.value),
    [encodeDecisionValue("approve", 42), encodeDecisionValue("reject", 42)],
  );
});

test("shotStateToBlocks: 'reject_reasons' renders one button per reason, encoding the reason code", () => {
  const state: ShotState = { kind: "reject_reasons", reasons: REASONS };
  const blocks = shotStateToBlocks(42, { sku: "HG-002", variantIndex: 1 }, state);
  const elements = (blocks[1] as any).elements;

  assert.equal(elements.length, REASONS.length);
  assert.deepStrictEqual(
    elements.map((e: any) => e.value),
    REASONS.map((r) => encodeDecisionValue("reject_reason", 42, r.code)),
  );
  assert.deepStrictEqual(
    elements.map((e: any) => e.text.text),
    REASONS.map((r) => r.label),
  );
});

test("shotStateToBlocks: 'decided' (approved) renders only an Undo button and names the decider", () => {
  const state: ShotState = {
    kind: "decided",
    decision: "approved",
    decidedBy: { id: "U1", displayName: "Ellie" },
  };
  const blocks = shotStateToBlocks(42, { sku: "HG-002", variantIndex: 1 }, state);

  assert.match((blocks[0] as any).text.text, /Ellie/);
  assert.match((blocks[0] as any).text.text, /Approved/);
  const elements = (blocks[1] as any).elements;
  assert.equal(elements.length, 1);
  assert.equal(elements[0].value, encodeDecisionValue("undo", 42));
});

test("shotStateToBlocks: 'decided' (rejected) includes the reason in the header text", () => {
  const state: ShotState = {
    kind: "decided",
    decision: "rejected",
    reason: "too staged",
    decidedBy: { id: "U1", displayName: "Ellie" },
  };
  const blocks = shotStateToBlocks(42, { sku: "HG-002", variantIndex: 1 }, state);
  assert.match((blocks[0] as any).text.text, /too staged/);
});

test("shotStateToBlocks: 'reopened' renders Approve/Reject again, same as 'decide'", () => {
  const decide = shotStateToBlocks(42, { sku: "HG-002", variantIndex: 1 }, { kind: "decide" });
  const reopened = shotStateToBlocks(
    42,
    { sku: "HG-002", variantIndex: 1 },
    { kind: "reopened" },
  );
  assert.deepStrictEqual((decide[1] as any).elements, (reopened[1] as any).elements);
  assert.notEqual((decide[0] as any).text.text, (reopened[0] as any).text.text);
});

test("buildGeneratedShotBlocks includes the image and initial Approve/Reject buttons", () => {
  const blocks = buildGeneratedShotBlocks({
    generationId: 99,
    sku: "HG-003",
    variantIndex: 2,
    shotIdea: "on a marble counter",
    imageUrl: "https://signed.example/img.png",
  });

  assert.equal(blocks[0].type, "section");
  assert.match((blocks[0] as any).text.text, /HG-003/);
  assert.match((blocks[0] as any).text.text, /marble counter/);

  assert.equal(blocks[1].type, "image");
  assert.equal((blocks[1] as any).image_url, "https://signed.example/img.png");

  assert.equal(blocks[2].type, "actions");
  const elements = (blocks[2] as any).elements;
  assert.deepStrictEqual(
    elements.map((e: any) => e.value),
    [encodeDecisionValue("approve", 99), encodeDecisionValue("reject", 99)],
  );
});

test("buildGeneratedShotBlocks includes the quality note when present, and omits it when absent", () => {
  const withNote = buildGeneratedShotBlocks({
    generationId: 1,
    sku: "HG-001",
    variantIndex: 0,
    shotIdea: "idea",
    imageUrl: "https://x/y.png",
    qualityNote: "⚠️ auto-check: blurry",
  });
  assert.match((withNote[0] as any).text.text, /blurry/);

  const withoutNote = buildGeneratedShotBlocks({
    generationId: 1,
    sku: "HG-001",
    variantIndex: 0,
    shotIdea: "idea",
    imageUrl: "https://x/y.png",
  });
  assert.doesNotMatch((withoutNote[0] as any).text.text, /auto-check/);
});

// ---------------------------------------------------------------------------
// 3. Ack-then-dispatch ordering (the important one)
// ---------------------------------------------------------------------------

/** A minimal, hand-rolled Bolt-shaped fake. Captures whatever listener each
 *  wiring call registers so a test can invoke it directly, the way Bolt's
 *  real receiver would after verifying+acking an inbound HTTP request. */
function createFakeBoltApp() {
  const commandHandlers = new Map<string, (args: BoltCommandArgs) => Promise<void>>();
  let actionHandler: ((args: BoltActionArgs) => Promise<void>) | undefined;
  let eventHandler: ((args: BoltEventArgs) => Promise<void>) | undefined;

  const app: BoltAppLike = {
    client: {
      chat: {
        postMessage: async () => ({ ts: "1700000000.000001", channel: "C123" }),
        update: async () => undefined,
      },
      files: {
        uploadV2: async () => ({}),
        info: async () => ({ file: { name: "catalog.csv", url_private: "https://x/f.csv" } }),
      },
    },
    command(name, fn) {
      commandHandlers.set(name, fn);
    },
    action(_actionId, fn) {
      actionHandler = fn;
    },
    event(_eventName, fn) {
      eventHandler = fn;
    },
    start: async () => undefined,
    stop: async () => undefined,
  };

  return {
    app,
    getCommandHandler: (name: string) => commandHandlers.get(name),
    getActionHandler: () => actionHandler,
    getEventHandler: () => eventHandler,
  };
}

test("onAction: ack() resolves before the registered decision handler's async work begins", async () => {
  const fake = createFakeBoltApp();
  const adapter = new SlackChatAdapter({
    botToken: "xoxb-test",
    signingSecret: "test-secret",
    channel: "C123",
    app: fake.app,
  });

  const events: string[] = [];
  adapter.onDecision(async () => {
    events.push("handler-start");
    await sleep(15); // stand-in for a real DB write
    events.push("handler-end");
  });

  await adapter.start();
  const boltActionHandler = fake.getActionHandler();
  assert.ok(boltActionHandler, "expected app.action to have registered a handler");

  const ack = async () => {
    events.push("ack");
  };
  const respond = async () => undefined;

  await boltActionHandler!({
    ack,
    respond,
    body: {
      user: { id: "U1", username: "ellie" },
      actions: [{ action_id: SHOT_ACTION_ID, value: encodeDecisionValue("approve", 42) }],
      container: { channel_id: "C123", message_ts: "1700000000.000100" },
    },
  });

  assert.deepStrictEqual(events, ["ack", "handler-start", "handler-end"]);
});

test("onAction: ack() still fires (and the handler still runs) even if the handler throws", async () => {
  const fake = createFakeBoltApp();
  const adapter = new SlackChatAdapter({
    botToken: "xoxb-test",
    signingSecret: "test-secret",
    channel: "C123",
    app: fake.app,
  });

  const events: string[] = [];
  adapter.onDecision(async () => {
    events.push("handler-start");
    throw new Error("boom");
  });

  await adapter.start();
  const boltActionHandler = fake.getActionHandler();

  const ack = async () => {
    events.push("ack");
  };

  // Must not throw out to the (fake) Bolt caller — a thrown handler error is
  // caught and logged internally, never surfacing after the ack.
  await assert.doesNotReject(
    boltActionHandler!({
      ack,
      respond: async () => undefined,
      body: {
        user: { id: "U1", username: "ellie" },
        actions: [{ action_id: SHOT_ACTION_ID, value: encodeDecisionValue("reject", 7) }],
        container: { channel_id: "C123", message_ts: "1700000000.000200" },
      },
    }),
  );

  assert.deepStrictEqual(events, ["ack", "handler-start"]);
});

test("onCommand: ack() resolves before the registered command handler's async work begins", async () => {
  const fake = createFakeBoltApp();
  const adapter = new SlackChatAdapter({
    botToken: "xoxb-test",
    signingSecret: "test-secret",
    channel: "C123",
    app: fake.app,
  });

  const events: string[] = [];
  adapter.onCommand(async (event) => {
    assert.equal(event.name, "status");
    events.push("handler-start");
    await sleep(10);
    events.push("handler-end");
  });

  await adapter.start();
  const boltStatusHandler = fake.getCommandHandler("/status");
  assert.ok(boltStatusHandler, "expected app.command('/status', ...) to have been registered");

  await boltStatusHandler!({
    ack: async () => {
      events.push("ack");
    },
    respond: async () => undefined,
    command: { text: "", user_id: "U1", user_name: "ellie", channel_id: "C123" },
  });

  assert.deepStrictEqual(events, ["ack", "handler-start", "handler-end"]);
});

test("onCommand: registers all five commands and passes through trimmed args", async () => {
  const fake = createFakeBoltApp();
  const adapter = new SlackChatAdapter({
    botToken: "xoxb-test",
    signingSecret: "test-secret",
    channel: "C123",
    app: fake.app,
  });

  let seenArgs: string | undefined;
  adapter.onCommand(async (event) => {
    if (event.name === "redo") seenArgs = event.args;
  });

  await adapter.start();

  for (const name of ["start", "status", "review", "export", "redo"]) {
    assert.ok(fake.getCommandHandler(`/${name}`), `expected /${name} to be registered`);
  }

  const redoHandler = fake.getCommandHandler("/redo")!;
  await redoHandler({
    ack: async () => undefined,
    respond: async () => undefined,
    command: { text: "  HG-002  ", user_id: "U1", channel_id: "C123" },
  });

  assert.equal(seenArgs, "HG-002");
});

test("onCsvUpload: the file_shared event handler downloads and forwards .csv uploads, and ignores a channel mismatch", async (t) => {
  const fake = createFakeBoltApp();
  const adapter = new SlackChatAdapter({
    botToken: "xoxb-test",
    signingSecret: "test-secret",
    channel: "C123",
    app: fake.app,
  });

  // No real network in this environment (and none should be needed for a
  // unit test) — stub the download `fetch` call and restore it after.
  const originalFetch = globalThis.fetch;
  let fetchWasCalled = false;
  const fetchCall: { url: unknown; authHeader: unknown } = { url: undefined, authHeader: undefined };
  globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    fetchWasCalled = true;
    fetchCall.url = url;
    fetchCall.authHeader = init?.headers?.Authorization;
    return {
      arrayBuffer: async () => new TextEncoder().encode("sku,name\nHG-001,Mug\n").buffer,
    } as Response;
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const uploads: Array<{ filename: string; bytes: number }> = [];
  adapter.onCsvUpload(async (event) => {
    uploads.push({ filename: event.filename, bytes: event.content.length });
  });

  await adapter.start();
  const eventHandler = fake.getEventHandler();
  assert.ok(eventHandler, "expected app.event('file_shared', ...) to have been registered");

  await eventHandler!({
    event: { type: "file_shared", file_id: "F1", user_id: "U1", channel_id: "C_OTHER" },
  });
  assert.deepStrictEqual(uploads, [], "upload in a different channel must be ignored");
  assert.equal(fetchWasCalled, false, "must not even download a file outside the configured channel");

  await eventHandler!({
    event: { type: "file_shared", file_id: "F1", user_id: "U1", channel_id: "C123" },
  });
  assert.deepStrictEqual(uploads, [{ filename: "catalog.csv", bytes: "sku,name\nHG-001,Mug\n".length }]);
  assert.equal(fetchCall.url, "https://x/f.csv");
  assert.equal(fetchCall.authHeader, "Bearer xoxb-test");
});

test("onCsvUpload: files.info reporting a non-.csv filename is not forwarded to the handler", async (t) => {
  const fake = createFakeBoltApp();
  fake.app.client.files.info = async () => ({
    file: { name: "notes.txt", url_private: "https://x/notes.txt" },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    arrayBuffer: async () => new ArrayBuffer(0),
  })) as unknown as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const adapter = new SlackChatAdapter({
    botToken: "xoxb-test",
    signingSecret: "test-secret",
    channel: "C123",
    app: fake.app,
  });

  const uploads: string[] = [];
  adapter.onCsvUpload(async (event) => {
    uploads.push(event.filename);
  });

  await adapter.start();
  const eventHandler = fake.getEventHandler();
  await eventHandler!({
    event: { type: "file_shared", file_id: "F2", user_id: "U1", channel_id: "C123" },
  });

  assert.deepStrictEqual(uploads, []);
});

test("updateShotMessage rejects a MessageRef that has no generationId (not a shot message)", async () => {
  const fake = createFakeBoltApp();
  const adapter = new SlackChatAdapter({
    botToken: "xoxb-test",
    signingSecret: "test-secret",
    channel: "C123",
    app: fake.app,
  });

  await assert.rejects(
    () =>
      adapter.updateShotMessage(
        buildMessageRef("C123", "1700000000.000100"),
        { sku: "HG-001", variantIndex: 0 },
        { kind: "decide" },
      ),
    /not a shot-message ref/,
  );
});

test("updateShotMessage falls back to posting a new message when chat.update fails", async () => {
  const fake = createFakeBoltApp();
  let updateCalled = false;
  let postCalled = false;
  fake.app.client.chat.update = async () => {
    updateCalled = true;
    throw new Error("edit window expired");
  };
  fake.app.client.chat.postMessage = async () => {
    postCalled = true;
    return { ts: "1700000000.000999", channel: "C123" };
  };

  const adapter = new SlackChatAdapter({
    botToken: "xoxb-test",
    signingSecret: "test-secret",
    channel: "C123",
    app: fake.app,
  });

  await adapter.updateShotMessage(
    buildMessageRef("C123", "1700000000.000100", 42),
    { sku: "HG-001", variantIndex: 0 },
    { kind: "decide" },
  );

  assert.ok(updateCalled);
  assert.ok(postCalled);
});
