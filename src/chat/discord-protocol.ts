/**
 * Discord wire-format helpers for the ChatAdapter implementation.
 *
 * Deliberately has ZERO dependency on the `discord.js` package — everything
 * here is pure data transformation (string encode/decode, plain objects
 * shaped like Discord's Message Components API). That's what lets
 * discord.test.ts exercise all of it with node:test today, without a live
 * bot and without `discord.js` even being installed yet. `discord.ts` is
 * the thin, actually-networked layer that imports these and wires them to
 * a real `Client`.
 */
import type { ChatUser, MessageRef, RejectReason, ShotState } from "./types.js";

// ---------------------------------------------------------------------------
// MessageRef: MessageRef is an opaque string per types.ts — Discord's own
// shape for "a message" is always a (channelId, messageId) pair (editing a
// message requires knowing which channel it lives in), so that pair is what
// gets serialized in and parsed back out.
// ---------------------------------------------------------------------------

/** Packs a Discord channel+message id pair into the opaque `MessageRef` string core persists. */
export function serializeMessageRef(channelId: string, messageId: string): MessageRef {
  return `${channelId}:${messageId}`;
}

/**
 * Unpacks a `MessageRef` produced by `serializeMessageRef`. Discord
 * snowflake ids are purely numeric, so splitting on the first colon is
 * unambiguous.
 */
export function parseMessageRef(ref: MessageRef): { channelId: string; messageId: string } {
  const idx = ref.indexOf(":");
  if (idx === -1) {
    throw new Error(`Malformed Discord MessageRef (expected "channelId:messageId"): ${ref}`);
  }
  return { channelId: ref.slice(0, idx), messageId: ref.slice(idx + 1) };
}

// ---------------------------------------------------------------------------
// custom_id encode/decode. Discord button custom_ids are capped at 100
// characters — see the test file for a worst-case check that this scheme
// stays comfortably inside that budget for all four action types.
// ---------------------------------------------------------------------------

export type DecisionAction = "approve" | "reject" | "reject_reason" | "undo";

const ACTION_PREFIX: Record<DecisionAction, string> = {
  approve: "appr",
  reject: "rej",
  reject_reason: "rejr",
  undo: "undo",
};

const PREFIX_TO_ACTION: Record<string, DecisionAction> = Object.fromEntries(
  Object.entries(ACTION_PREFIX).map(([action, prefix]) => [prefix, action as DecisionAction]),
);

export interface DecodedCustomId {
  action: DecisionAction;
  generationId: number;
  /** Present only when action === "reject_reason". */
  reasonCode?: string;
}

/** Encodes a button's identity into a Discord custom_id. Throws if the result would exceed Discord's 100-char cap. */
export function encodeCustomId(
  action: DecisionAction,
  generationId: number,
  reasonCode?: string,
): string {
  const parts = [ACTION_PREFIX[action], String(generationId)];
  if (action === "reject_reason") {
    if (!reasonCode) {
      throw new Error("encodeCustomId: reject_reason requires a reasonCode");
    }
    parts.push(reasonCode);
  }
  const customId = parts.join(":");
  if (customId.length > 100) {
    throw new Error(
      `encodeCustomId: custom_id exceeds Discord's 100-char limit (${customId.length} chars): ${customId}`,
    );
  }
  return customId;
}

/** Inverse of encodeCustomId. Returns null (never throws) for anything unrecognized — stale/foreign buttons should be ignored, not crash the handler. */
export function decodeCustomId(customId: string): DecodedCustomId | null {
  const [prefix, idStr, reasonCode] = customId.split(":");
  const action = prefix ? PREFIX_TO_ACTION[prefix] : undefined;
  if (!action) return null;
  const generationId = Number(idStr);
  if (!Number.isFinite(generationId)) return null;
  if (action === "reject_reason") {
    if (!reasonCode) return null;
    return { action, generationId, reasonCode };
  }
  return { action, generationId };
}

// ---------------------------------------------------------------------------
// ShotState -> Discord message components. Minimal local types mirroring
// Discord's Message Components API (v10) JSON shape — intentionally not
// imported from discord.js, so this stays dependency-free. discord.js
// accepts plain objects shaped like this directly wherever it accepts
// component builders.
// ---------------------------------------------------------------------------

/** Discord button styles (Message Components API v10). */
const ButtonStyle = {
  Primary: 1,
  Secondary: 2,
  Success: 3,
  Danger: 4,
} as const;

export interface ApiButtonComponent {
  type: 2;
  style: number;
  label: string;
  custom_id: string;
}

export interface ApiActionRow {
  type: 1;
  components: ApiButtonComponent[];
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

function decideRow(generationId: number): ApiActionRow {
  return {
    type: 1,
    components: [
      {
        type: 2,
        style: ButtonStyle.Success,
        label: "✅ Approve",
        custom_id: encodeCustomId("approve", generationId),
      },
      {
        type: 2,
        style: ButtonStyle.Danger,
        label: "❌ Reject",
        custom_id: encodeCustomId("reject", generationId),
      },
    ],
  };
}

/**
 * Renders a `ShotState` as Discord action rows for a given generation.
 *
 * NOTE on Discord's 5-buttons-per-row / 5-rows-per-message caps: the
 * `reject_reasons` case is where this actually bites. Today's reason list
 * (see REJECT_REASONS in the old telegram/bot.ts, now supplied by core) has
 * exactly 5 entries — this chunks them into exactly one full row with zero
 * spare slots. A 6th reason wraps into a second row (still fine, up to 25
 * reasons/5 rows total); beyond 25 there is no way to lay them out at all,
 * so that case throws loudly instead of silently dropping buttons.
 */
export function shotStateToComponents(state: ShotState, generationId: number): ApiActionRow[] {
  switch (state.kind) {
    case "decide":
    case "reopened":
      return [decideRow(generationId)];

    case "reject_reasons": {
      if (state.reasons.length === 0) {
        throw new Error("shotStateToComponents: reject_reasons requires at least one reason");
      }
      if (state.reasons.length > 25) {
        throw new Error(
          `shotStateToComponents: ${state.reasons.length} reject reasons exceed Discord's ` +
            `25-button-per-message cap (5 rows x 5 buttons)`,
        );
      }
      return chunk(state.reasons, 5).map((row) => ({
        type: 1,
        components: row.map(
          (reason): ApiButtonComponent => ({
            type: 2,
            style: ButtonStyle.Secondary,
            label: reason.label,
            custom_id: encodeCustomId("reject_reason", generationId, reason.code),
          }),
        ),
      }));
    }

    case "decided":
      return [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: ButtonStyle.Secondary,
              label: "↩️ Undo",
              custom_id: encodeCustomId("undo", generationId),
            },
          ],
        },
      ];
  }
}

// ---------------------------------------------------------------------------
// Text formatting. Also pure/dependency-free so it's covered by the same
// tests as the component mapping.
// ---------------------------------------------------------------------------

export interface ShotMessageContext {
  sku: string;
  variantIndex: number;
}

/** Renders the text body of a shot-review message for a given state. */
export function formatShotCaption(
  ctx: ShotMessageContext,
  state: ShotState,
  extra?: { shotIdea?: string; qualityNote?: string },
): string {
  const header = extra?.shotIdea
    ? `**${ctx.sku}** — "${extra.shotIdea}" (variant ${ctx.variantIndex})`
    : `**${ctx.sku}** — variant ${ctx.variantIndex}`;
  const lines = [header];
  if (extra?.qualityNote) lines.push(`⚠️ auto-check: ${extra.qualityNote}`);

  switch (state.kind) {
    case "decide":
      break;
    case "reject_reasons":
      lines.push("Pick a reason:");
      break;
    case "decided":
      lines.push(decidedBadge(state.decision, state.reason), `— ${decidedByLabel(state.decidedBy)}`);
      break;
    case "reopened":
      lines.push("↩️ Reopened for review");
      break;
  }
  return lines.join("\n");
}

function decidedBadge(decision: "approved" | "rejected", reason?: string): string {
  return decision === "approved" ? "✅ Approved" : `❌ Rejected${reason ? ` (${reason})` : ""}`;
}

function decidedByLabel(user: ChatUser): string {
  return user.displayName;
}
