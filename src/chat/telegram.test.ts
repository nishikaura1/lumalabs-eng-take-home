import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CALLBACK_DATA_BYTE_LIMIT,
  encodeCallbackData,
  decodeCallbackData,
  encodeMessageRef,
  decodeMessageRef,
  shotStateToKeyboard,
  buildShotCaption,
  buildInitialShotCaption,
  type DecisionAction,
} from "./telegram.js";
import type { ChatUser, RejectReason, ShotState } from "./types.js";

const ACTIONS: DecisionAction[] = ["approve", "reject", "reject_reason", "undo"];

const REASONS: RejectReason[] = [
  { code: "staged", label: "too staged" },
  { code: "light", label: "lighting/mood off" },
  { code: "prod", label: "product not recognizable" },
  { code: "scene", label: "wrong scene/setting" },
  { code: "other", label: "other" },
];

const ELLIE: ChatUser = { id: "12345", displayName: "ellie" };

// ----------------------------------------------------------------------------
// callback_data encode/decode round-trip
// ----------------------------------------------------------------------------

describe("encodeCallbackData / decodeCallbackData", () => {
  for (const action of ACTIONS) {
    test(`round-trips "${action}" with a small generationId`, () => {
      const reasonCode = action === "reject_reason" ? "staged" : undefined;
      const encoded = encodeCallbackData(action, 7, reasonCode);
      const decoded = decodeCallbackData(encoded);
      // reasonCode is only ever present on the decoded object for
      // "reject_reason" (per DecisionEvent's doc comment) — build the
      // expectation without the key at all for the other three actions,
      // rather than `reasonCode: undefined`, which deepStrictEqual treats
      // as a different shape from a genuinely absent key.
      assert.deepEqual(
        decoded,
        action === "reject_reason" ? { action, generationId: 7, reasonCode } : { action, generationId: 7 },
      );
    });

    test(`round-trips "${action}" with a large generationId`, () => {
      const reasonCode = action === "reject_reason" ? "other" : undefined;
      const bigId = 987_654_321;
      const encoded = encodeCallbackData(action, bigId, reasonCode);
      const decoded = decodeCallbackData(encoded);
      assert.deepEqual(
        decoded,
        action === "reject_reason"
          ? { action, generationId: bigId, reasonCode }
          : { action, generationId: bigId },
      );
    });
  }

  test("round-trips every real REJECT_REASONS code", () => {
    for (const reason of REASONS) {
      const encoded = encodeCallbackData("reject_reason", 42, reason.code);
      const decoded = decodeCallbackData(encoded);
      assert.deepEqual(decoded, { action: "reject_reason", generationId: 42, reasonCode: reason.code });
    }
  });

  test("matches the original bot.ts wire format exactly", () => {
    assert.equal(encodeCallbackData("approve", 5), "appr:5");
    assert.equal(encodeCallbackData("reject", 5), "rej:5");
    assert.equal(encodeCallbackData("reject_reason", 5, "staged"), "rejr:5:staged");
    assert.equal(encodeCallbackData("undo", 5), "undo:5");
  });

  test("every real reject-reason payload stays comfortably under the 64-byte budget", () => {
    for (const reason of REASONS) {
      const encoded = encodeCallbackData("reject_reason", 999_999_999, reason.code);
      assert.ok(
        Buffer.byteLength(encoded, "utf-8") <= CALLBACK_DATA_BYTE_LIMIT,
        `"${encoded}" exceeded the callback_data budget`,
      );
    }
  });

  test("throws instead of silently truncating when the budget would be exceeded", () => {
    const wayTooLong = "x".repeat(80);
    assert.throws(() => encodeCallbackData("reject_reason", 1, wayTooLong), /64-byte limit/);
  });

  test("decodeCallbackData rejects garbage input rather than throwing", () => {
    assert.equal(decodeCallbackData(""), null);
    assert.equal(decodeCallbackData("not-a-known-prefix:5"), null);
    assert.equal(decodeCallbackData("appr:not-a-number"), null);
    assert.equal(decodeCallbackData("appr"), null); // missing id entirely
    assert.equal(decodeCallbackData("rejr:5"), null); // reject_reason with no reasonCode
  });
});

// ----------------------------------------------------------------------------
// MessageRef encode/decode round-trip
// ----------------------------------------------------------------------------

describe("encodeMessageRef / decodeMessageRef", () => {
  test("round-trips messageId + generationId", () => {
    const ref = encodeMessageRef(918273, 456);
    assert.deepEqual(decodeMessageRef(ref), { messageId: 918273, generationId: 456 });
  });

  test("returns null for a ref this adapter didn't mint", () => {
    assert.equal(decodeMessageRef("not-numeric:also-not"), null);
    assert.equal(decodeMessageRef("just-a-plain-id"), null);
  });
});

// ----------------------------------------------------------------------------
// ShotState -> Telegram inline keyboard mapping
// ----------------------------------------------------------------------------

describe("shotStateToKeyboard", () => {
  test('"decide" renders Approve/Reject bound to the given generationId', () => {
    const kb = shotStateToKeyboard(101, { kind: "decide" });
    assert.deepEqual(kb, [
      [
        { text: "✅ Approve", callback_data: "appr:101" },
        { text: "❌ Reject", callback_data: "rej:101" },
      ],
    ]);
  });

  test('"reopened" renders the same controls as "decide"', () => {
    const decide = shotStateToKeyboard(202, { kind: "decide" });
    const reopened = shotStateToKeyboard(202, { kind: "reopened" });
    assert.deepEqual(reopened, decide);
  });

  test('"reject_reasons" renders one button per reason, in order, with matching codes', () => {
    const kb = shotStateToKeyboard(303, { kind: "reject_reasons", reasons: REASONS });
    assert.equal(kb?.length, 1);
    assert.equal(kb?.[0].length, REASONS.length);
    kb?.[0].forEach((button, i) => {
      assert.equal(button.text, REASONS[i].label);
      assert.equal(button.callback_data, `rejr:303:${REASONS[i].code}`);
    });
  });

  test('"decided" renders a single Undo control', () => {
    const kb = shotStateToKeyboard(404, {
      kind: "decided",
      decision: "approved",
      decidedBy: ELLIE,
    });
    assert.deepEqual(kb, [[{ text: "↩️ Undo", callback_data: "undo:404" }]]);
  });
});

// ----------------------------------------------------------------------------
// Caption rendering (pure, also cleanly separable from grammy)
// ----------------------------------------------------------------------------

describe("buildShotCaption", () => {
  const ctx = { sku: "HG-002", variantIndex: 2 };

  test("decide / reject_reasons show sku + variant, no decision info", () => {
    assert.equal(buildShotCaption(ctx, { kind: "decide" }), "HG-002 — variant 2");
    assert.equal(
      buildShotCaption(ctx, { kind: "reject_reasons", reasons: REASONS }),
      "HG-002 — variant 2",
    );
  });

  test("reopened calls out that it was reopened", () => {
    assert.equal(buildShotCaption(ctx, { kind: "reopened" }), "HG-002 — reopened for review");
  });

  test("decided (approved) includes the badge and who decided", () => {
    const state: ShotState = { kind: "decided", decision: "approved", decidedBy: ELLIE };
    assert.equal(buildShotCaption(ctx, state), "HG-002 — variant 2\n✅ Approved\n— ellie");
  });

  test("decided (rejected) includes the reason", () => {
    const state: ShotState = {
      kind: "decided",
      decision: "rejected",
      reason: "too staged",
      decidedBy: ELLIE,
    };
    assert.equal(buildShotCaption(ctx, state), "HG-002 — variant 2\n❌ Rejected (too staged)\n— ellie");
  });
});

describe("buildInitialShotCaption", () => {
  test("includes sku, shot idea, and variant", () => {
    const caption = buildInitialShotCaption({
      generationId: 1,
      sku: "HG-002",
      variantIndex: 1,
      shotIdea: "on a sunlit oak table",
      imageUrl: "https://example.com/img.png",
    });
    assert.equal(caption, 'HG-002 — "on a sunlit oak table" (variant 1)');
  });

  test("appends the quality note on its own line when present", () => {
    const caption = buildInitialShotCaption({
      generationId: 1,
      sku: "HG-002",
      variantIndex: 1,
      shotIdea: "on a sunlit oak table",
      qualityNote: "⚠️ auto-check: product not fully visible",
      imageUrl: "https://example.com/img.png",
    });
    assert.equal(
      caption,
      'HG-002 — "on a sunlit oak table" (variant 1)\n⚠️ auto-check: product not fully visible',
    );
  });
});
