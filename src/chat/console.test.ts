/**
 * Contract tests for ConsoleChatAdapter, in isolation — no DB, no worker,
 * no other adapter. Each test wires up minimal onCommand/onDecision/
 * onCsvUpload handlers that stand in for what core (bot.ts-equivalent)
 * would do, then drives them via the adapter's own simulate* methods and
 * asserts against sentMessages / shotUpdates / acknowledgements.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ConsoleChatAdapter, ELLIE_TEST_USER } from "./console.js";
import type { DecisionEvent, GeneratedShotContent, RejectReason } from "./types.js";

const REASONS: RejectReason[] = [
  { code: "staged", label: "too staged" },
  { code: "light", label: "lighting/mood off" },
  { code: "other", label: "other" },
];

function shotContent(overrides: Partial<GeneratedShotContent> = {}): GeneratedShotContent {
  return {
    generationId: 1,
    sku: "HG-002",
    variantIndex: 0,
    shotIdea: "on a sunlit oak table",
    imageUrl: "https://example.com/signed/shot.png",
    ...overrides,
  };
}

/**
 * Minimal stand-in for the core decision handler in bot.ts: reject shows a
 * reason picker; approve/reject_reason land on "decided"; undo reopens.
 * Registered fresh per test so adapters/handlers never leak across tests.
 */
function wireCoreLikeHandler(adapter: ConsoleChatAdapter, calls: string[]) {
  adapter.onDecision(async (event: DecisionEvent) => {
    calls.push(`handler:${event.action}`);
    await event.acknowledge({ text: event.action === "approve" ? "Approved" : "OK" });
    calls.push(`ack:${event.action}`);

    const context = { sku: "HG-002", variantIndex: 0 };

    if (event.action === "reject") {
      await adapter.updateShotMessage(event.messageRef, context, {
        kind: "reject_reasons",
        reasons: REASONS,
      });
      return;
    }
    if (event.action === "reject_reason") {
      const reason = REASONS.find((r) => r.code === event.reasonCode);
      await adapter.updateShotMessage(event.messageRef, context, {
        kind: "decided",
        decision: "rejected",
        reason: reason?.label ?? event.reasonCode,
        decidedBy: event.actor,
      });
      return;
    }
    if (event.action === "approve") {
      await adapter.updateShotMessage(event.messageRef, context, {
        kind: "decided",
        decision: "approved",
        decidedBy: event.actor,
      });
      return;
    }
    if (event.action === "undo") {
      await adapter.updateShotMessage(event.messageRef, context, { kind: "reopened" });
      return;
    }
  });
}

describe("ConsoleChatAdapter — outbound sends", () => {
  test("sendGeneratedShot records a shot in sentMessages and starts in decide state", async () => {
    const adapter = new ConsoleChatAdapter();
    await adapter.start();
    const content = shotContent();
    const ref = await adapter.sendGeneratedShot(content);

    assert.equal(adapter.sentMessages.length, 1);
    assert.deepEqual(adapter.sentMessages[0], { kind: "shot", ref, at: adapter.sentMessages[0].at, content });
    assert.deepEqual(adapter.getShotState(content.generationId), { kind: "decide" });
  });

  test("sendText / sendDocument / sendCriticalAlert each produce a distinct sentMessages entry", async () => {
    const adapter = new ConsoleChatAdapter();
    await adapter.start();

    await adapter.sendText("status line");
    await adapter.sendDocument({
      fileName: "catalog-export-1.csv",
      content: Buffer.from("sku,status\n"),
      contentType: "text/csv",
    });
    await adapter.sendCriticalAlert("Luma API down");

    assert.deepEqual(
      adapter.sentMessages.map((m) => m.kind),
      ["text", "document", "alert"],
    );
  });

  test("updateShotMessage on an unknown ref throws rather than silently posting a new message", async () => {
    const adapter = new ConsoleChatAdapter();
    await adapter.start();
    await assert.rejects(
      () => adapter.updateShotMessage("bogus-ref", { sku: "HG-002", variantIndex: 0 }, { kind: "decide" }),
      /unknown message ref/,
    );
  });
});

describe("ConsoleChatAdapter — decision event shape", () => {
  test("simulateApprove delivers a DecisionEvent matching the sent shot", async () => {
    const adapter = new ConsoleChatAdapter();
    const received: DecisionEvent[] = [];
    adapter.onDecision(async (event) => {
      received.push(event);
      await event.acknowledge();
    });
    await adapter.start();

    const content = shotContent({ generationId: 42 });
    const ref = await adapter.sendGeneratedShot(content);

    await adapter.simulateApprove(42);

    assert.equal(received.length, 1);
    assert.equal(received[0].action, "approve");
    assert.equal(received[0].generationId, 42);
    assert.equal(received[0].messageRef, ref);
    assert.deepEqual(received[0].actor, ELLIE_TEST_USER);
    assert.equal(received[0].reasonCode, undefined);
  });

  test("simulateCommand and simulateCatalogUpload deliver matching events", async () => {
    const adapter = new ConsoleChatAdapter();
    let commandSeen: { name: string; args: string } | undefined;
    let uploadSeen: { filename: string; text: string } | undefined;
    adapter.onCommand((e) => {
      commandSeen = { name: e.name, args: e.args };
    });
    adapter.onCsvUpload((e) => {
      uploadSeen = { filename: e.filename, text: e.content.toString("utf-8") };
    });
    await adapter.start();

    await adapter.simulateCommand("redo", "HG-002");
    assert.deepEqual(commandSeen, { name: "redo", args: "HG-002" });

    await adapter.simulateCatalogUpload("drop.csv", "sku,name\nHG-002,Vase\n");
    assert.deepEqual(uploadSeen, { filename: "drop.csv", text: "sku,name\nHG-002,Vase\n" });
  });

  test("simulating before start() throws", async () => {
    const adapter = new ConsoleChatAdapter();
    adapter.onCommand(() => {});
    await assert.rejects(() => adapter.simulateCommand("status"), /call start\(\)/);
  });

  test("simulating a decision with no onDecision handler registered throws", async () => {
    const adapter = new ConsoleChatAdapter();
    await adapter.start();
    await adapter.sendGeneratedShot(shotContent());
    await assert.rejects(() => adapter.simulateApprove(1), /no onDecision handler/);
  });
});

describe("ConsoleChatAdapter — full shot lifecycle", () => {
  test("decide -> reject_reasons -> decided -> reopened -> decided again", async () => {
    const adapter = new ConsoleChatAdapter();
    const calls: string[] = [];
    wireCoreLikeHandler(adapter, calls);
    await adapter.start();

    const content = shotContent({ generationId: 7 });
    await adapter.sendGeneratedShot(content);
    assert.deepEqual(adapter.getShotState(7), { kind: "decide" });

    // reject tap 1 -> reason picker
    await adapter.simulateReject(7, "staged");
    // simulateReject drives both taps; final state should be "decided"
    assert.deepEqual(adapter.getShotState(7), {
      kind: "decided",
      decision: "rejected",
      reason: "too staged",
      decidedBy: ELLIE_TEST_USER,
    });

    // Undo -> reopened (per types.ts, distinct from "decide")
    await adapter.simulateUndo(7);
    assert.deepEqual(adapter.getShotState(7), { kind: "reopened" });

    // Reopened shot is decidable again
    await adapter.simulateApprove(7);
    assert.deepEqual(adapter.getShotState(7), {
      kind: "decided",
      decision: "approved",
      decidedBy: ELLIE_TEST_USER,
    });

    // Sanity: ack always fires before the handler's slow work for every tap.
    // (handler pushes "handler:X" then "ack:X" itself before any updateShotMessage)
    assert.deepEqual(calls, [
      "handler:reject",
      "ack:reject",
      "handler:reject_reason",
      "ack:reject_reason",
      "handler:undo",
      "ack:undo",
      "handler:approve",
      "ack:approve",
    ]);

    // shotUpdates recorded every transition in order.
    assert.deepEqual(
      adapter.shotUpdates.map((u) => u.state.kind),
      ["reject_reasons", "decided", "reopened", "decided"],
    );

    // acknowledge() was actually recorded for every one of the 4 taps.
    assert.equal(adapter.acknowledgements.length, 4);
  });

  test("acknowledge is recorded before the corresponding updateShotMessage lands", async () => {
    const adapter = new ConsoleChatAdapter();
    wireCoreLikeHandler(adapter, []);
    await adapter.start();
    await adapter.sendGeneratedShot(shotContent({ generationId: 9 }));

    await adapter.simulateApprove(9);

    assert.equal(adapter.acknowledgements.length, 1);
    assert.equal(adapter.shotUpdates.length, 1);
    assert.ok(adapter.acknowledgements[0].at.getTime() <= adapter.shotUpdates[0].at.getTime());
  });
});

describe("ConsoleChatAdapter — simulateReject drives the two-tap flow against live state", () => {
  test("happy path: reads back the reasons the handler actually offered", async () => {
    const adapter = new ConsoleChatAdapter();
    wireCoreLikeHandler(adapter, []);
    await adapter.start();
    await adapter.sendGeneratedShot(shotContent({ generationId: 3 }));

    await adapter.simulateReject(3, "light");

    const state = adapter.getShotState(3);
    assert.equal(state?.kind, "decided");
    if (state?.kind === "decided") {
      assert.equal(state.reason, "lighting/mood off");
    }
  });

  test("rejects a reasonCode that was never actually offered, instead of firing it blindly", async () => {
    const adapter = new ConsoleChatAdapter();
    wireCoreLikeHandler(adapter, []);
    await adapter.start();
    await adapter.sendGeneratedShot(shotContent({ generationId: 4 }));

    await assert.rejects(() => adapter.simulateReject(4, "not-a-real-reason"), /not among the reasons currently offered/);

    // And because it never fired reject_reason, the live state is still the
    // reason picker from tap 1 — not silently "decided".
    assert.equal(adapter.getShotState(4)?.kind, "reject_reasons");
  });

  test("surfaces a broken handler that never presents a reason picker, rather than assuming button state", async () => {
    const adapter = new ConsoleChatAdapter();
    // Deliberately broken: reject tap does nothing (no updateShotMessage at all).
    adapter.onDecision(async (event) => {
      await event.acknowledge();
    });
    await adapter.start();
    await adapter.sendGeneratedShot(shotContent({ generationId: 5 }));

    await assert.rejects(() => adapter.simulateReject(5, "staged"), /did not present a reason picker/);
  });
});
