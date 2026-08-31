/**
 * Tests for the Discord wire-format helpers (src/chat/discord-protocol.ts).
 *
 * Deliberately does NOT import discord.ts / the discord.js package — there's
 * no live bot available in this environment (and discord.js isn't installed
 * yet), so this is scoped to what's pure and platform-independent: the
 * MessageRef round-trip, the custom_id encode/decode scheme, and the
 * ShotState -> components/text mapping. All of it runs today via
 * `node --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RejectReason } from "./types.js";
import {
  decodeCustomId,
  encodeCustomId,
  formatShotCaption,
  parseMessageRef,
  serializeMessageRef,
  shotStateToComponents,
  type DecisionAction,
} from "./discord-protocol.js";

// ---------------------------------------------------------------------------
// MessageRef
// ---------------------------------------------------------------------------

test("MessageRef: serialize/parse round-trips a channel+message id pair", () => {
  const ref = serializeMessageRef("111111111111111111", "222222222222222222");
  assert.equal(ref, "111111111111111111:222222222222222222");
  assert.deepEqual(parseMessageRef(ref), {
    channelId: "111111111111111111",
    messageId: "222222222222222222",
  });
});

test("MessageRef: parse throws on a malformed ref", () => {
  assert.throws(() => parseMessageRef("not-a-valid-ref"));
});

// ---------------------------------------------------------------------------
// custom_id encode/decode
// ---------------------------------------------------------------------------

test("custom_id: round-trips for all four decision actions", () => {
  const cases: Array<[DecisionAction, number, string | undefined]> = [
    ["approve", 42, undefined],
    ["reject", 42, undefined],
    ["reject_reason", 42, "staged"],
    ["undo", 42, undefined],
  ];
  for (const [action, generationId, reasonCode] of cases) {
    const id = encodeCustomId(action, generationId, reasonCode);
    assert.ok(id.length <= 100, `custom_id exceeds Discord's 100-char cap: ${id.length} (${id})`);
    const expected = reasonCode === undefined ? { action, generationId } : { action, generationId, reasonCode };
    assert.deepEqual(decodeCustomId(id), expected);
  }
});

test("custom_id: comfortably fits Discord's 100-char budget even in a worst case", () => {
  const longReasonCode = "a".repeat(60);
  const id = encodeCustomId("reject_reason", Number.MAX_SAFE_INTEGER, longReasonCode);
  assert.ok(
    id.length <= 100,
    `expected headroom to spare, got ${id.length} chars for a MAX_SAFE_INTEGER id + 60-char reason code: ${id}`,
  );
});

test("custom_id: encode throws for reject_reason with no reasonCode", () => {
  assert.throws(() => encodeCustomId("reject_reason", 1));
});

test("custom_id: decode returns null (never throws) for unrecognized ids", () => {
  assert.equal(decodeCustomId("not:a:known:prefix"), null);
  assert.equal(decodeCustomId("appr:not-a-number"), null);
  assert.equal(decodeCustomId("rejr:5"), null); // missing reasonCode
});

// ---------------------------------------------------------------------------
// ShotState -> components
// ---------------------------------------------------------------------------

test("components: 'decide' is one row of Approve + Reject", () => {
  const rows = shotStateToComponents({ kind: "decide" }, 7);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    rows[0].components.map((c) => c.custom_id),
    [encodeCustomId("approve", 7), encodeCustomId("reject", 7)],
  );
});

test("components: 'reopened' renders the same layout as 'decide'", () => {
  assert.deepEqual(
    shotStateToComponents({ kind: "reopened" }, 7),
    shotStateToComponents({ kind: "decide" }, 7),
  );
});

test("components: 'decided' is a single Undo button", () => {
  const rows = shotStateToComponents(
    {
      kind: "decided",
      decision: "approved",
      decidedBy: { id: "1", displayName: "Ellie" },
    },
    9,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].components.length, 1);
  assert.equal(rows[0].components[0].custom_id, encodeCustomId("undo", 9));
});

test("components: today's 5 reject reasons fill exactly one row — zero headroom", () => {
  // Mirrors REJECT_REASONS from the old telegram/bot.ts, now supplied by core.
  const reasons: RejectReason[] = [
    { code: "staged", label: "too staged" },
    { code: "light", label: "lighting/mood off" },
    { code: "prod", label: "product not recognizable" },
    { code: "scene", label: "wrong scene/setting" },
    { code: "other", label: "other" },
  ];
  const rows = shotStateToComponents({ kind: "reject_reasons", reasons }, 3);
  assert.equal(rows.length, 1, "5 reasons should fit in exactly one action row");
  assert.equal(
    rows[0].components.length,
    5,
    "Discord caps 5 buttons/row — this is already maxed out, matching the SYNTHESIS.md note",
  );
});

test("components: a 6th reject reason wraps into a second row", () => {
  const reasons: RejectReason[] = Array.from({ length: 6 }, (_, i) => ({
    code: `r${i}`,
    label: `reason ${i}`,
  }));
  const rows = shotStateToComponents({ kind: "reject_reasons", reasons }, 3);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].components.length, 5);
  assert.equal(rows[1].components.length, 1);
});

test("components: more than 25 reject reasons is a hard Discord limit — rejected loudly, not silently truncated", () => {
  const reasons: RejectReason[] = Array.from({ length: 26 }, (_, i) => ({
    code: `r${i}`,
    label: `reason ${i}`,
  }));
  assert.throws(() => shotStateToComponents({ kind: "reject_reasons", reasons }, 3));
});

test("components: reject_reasons requires at least one reason", () => {
  assert.throws(() => shotStateToComponents({ kind: "reject_reasons", reasons: [] }, 3));
});

// ---------------------------------------------------------------------------
// Text formatting
// ---------------------------------------------------------------------------

test("formatShotCaption: 'decide' shows sku + shot idea + variant", () => {
  const text = formatShotCaption(
    { sku: "HG-002", variantIndex: 1 },
    { kind: "decide" },
    { shotIdea: "on a marble counter" },
  );
  assert.match(text, /HG-002/);
  assert.match(text, /on a marble counter/);
  assert.match(text, /variant 1/);
});

test("formatShotCaption: 'decided'/approved includes the badge and who decided", () => {
  const text = formatShotCaption(
    { sku: "HG-002", variantIndex: 1 },
    { kind: "decided", decision: "approved", decidedBy: { id: "1", displayName: "Ellie" } },
  );
  assert.match(text, /Approved/);
  assert.match(text, /Ellie/);
});

test("formatShotCaption: 'decided'/rejected includes the reason", () => {
  const text = formatShotCaption(
    { sku: "HG-002", variantIndex: 1 },
    {
      kind: "decided",
      decision: "rejected",
      reason: "too staged",
      decidedBy: { id: "1", displayName: "Ellie" },
    },
  );
  assert.match(text, /Rejected/);
  assert.match(text, /too staged/);
});

test("formatShotCaption: 'reopened' says so", () => {
  const text = formatShotCaption({ sku: "HG-002", variantIndex: 1 }, { kind: "reopened" });
  assert.match(text, /Reopened/i);
});
