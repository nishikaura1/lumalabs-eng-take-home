/**
 * Pure, Slack-shaped helpers for the SlackChatAdapter (src/chat/slack.ts).
 *
 * Deliberately has ZERO dependency on `@slack/bolt` — everything here is
 * plain data-in/data-out so it can be unit tested (see slack.test.ts)
 * without a Slack workspace, a mocked Bolt `App`, or the package even being
 * installed. `slack.ts` imports these and wires them up to Bolt.
 */
import type {
  ChatUser,
  GeneratedShotContent,
  MessageRef,
  RejectReason,
  ShotState,
} from "./types.js";

// ---------------------------------------------------------------------------
// Decision value encoding — the payload carried in a Block Kit button's
// `value` field.
// ---------------------------------------------------------------------------

export type DecisionAction = "approve" | "reject" | "reject_reason" | "undo";

const DECISION_ACTIONS: readonly DecisionAction[] = [
  "approve",
  "reject",
  "reject_reason",
  "undo",
];

/**
 * Single app-wide `action_id` shared by every shot-review button.
 *
 * Slack routes an interaction by `action_id` (+ `block_id`), not by a
 * per-button free-form string the way Telegram's `callback_data` works — so
 * there's exactly one action_id for this whole app, and the real payload
 * (which action, which generation, which reject reason) travels entirely
 * inside `value` via encodeDecisionValue/decodeDecisionValue below.
 */
export const SHOT_ACTION_ID = "styled_shots_decision";

export interface DecodedDecisionValue {
  action: DecisionAction;
  generationId: number;
  /** Present only when action === "reject_reason". */
  reasonCode?: string;
}

/**
 * Encodes one shot-review action into a single button `value` string.
 * Mirrors the encoding pre-refactor telegram/bot.ts used for callback_data
 * (`"appr:42"`, `"rejr:42:staged"`, ...), adapted to this repo's action
 * names.
 */
export function encodeDecisionValue(
  action: DecisionAction,
  generationId: number,
  reasonCode?: string,
): string {
  return reasonCode !== undefined
    ? `${action}:${generationId}:${reasonCode}`
    : `${action}:${generationId}`;
}

/**
 * Inverse of encodeDecisionValue. Returns `null` for anything malformed or
 * unrecognized rather than throwing — a stale or hostile `value` (e.g. from
 * a message rendered by a since-changed app version, or a redelivered/
 * tampered payload) must not crash the interaction handler.
 */
export function decodeDecisionValue(value: string): DecodedDecisionValue | null {
  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const [action, idStr, reasonCode] = parts;
  if (!action || !DECISION_ACTIONS.includes(action as DecisionAction)) return null;
  if (!idStr || !/^-?\d+$/.test(idStr)) return null;
  const generationId = Number(idStr);
  if (!Number.isInteger(generationId)) return null;
  if (action !== "reject_reason" && reasonCode !== undefined) return null;
  if (action === "reject_reason" && !reasonCode) return null;
  return { action: action as DecisionAction, generationId, reasonCode };
}

// ---------------------------------------------------------------------------
// MessageRef encoding — what SlackChatAdapter mints from sendGeneratedShot/
// sendText and later parses back out of updateShotMessage's `ref`.
// ---------------------------------------------------------------------------

export interface ParsedSlackMessageRef {
  channel: string;
  ts: string;
  /** Only present for a ref that came from sendGeneratedShot — needed so
   *  updateShotMessage can re-encode button values without core ever having
   *  to pass a generationId back in (its signature intentionally doesn't
   *  carry one — see types.ts). */
  generationId?: number;
}

/**
 * `MessageRef` is an opaque string per types.ts — this adapter's choice is
 * `"<channel>:<ts>"`, or `"<channel>:<ts>:<generationId>"` for a shot-review
 * message, so a later updateShotMessage call can recover the generationId
 * needed to rebuild button values without core needing to supply one.
 */
export function buildMessageRef(
  channel: string,
  ts: string,
  generationId?: number,
): MessageRef {
  return generationId !== undefined ? `${channel}:${ts}:${generationId}` : `${channel}:${ts}`;
}

export function parseMessageRef(ref: MessageRef): ParsedSlackMessageRef | null {
  const parts = ref.split(":");
  if (parts.length === 2) {
    const [channel, ts] = parts;
    if (!channel || !ts) return null;
    return { channel, ts };
  }
  if (parts.length === 3) {
    const [channel, ts, idStr] = parts;
    if (!channel || !ts || !idStr || !/^-?\d+$/.test(idStr)) return null;
    const generationId = Number(idStr);
    if (!Number.isInteger(generationId)) return null;
    return { channel, ts, generationId };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Minimal local Block Kit types — just what this app emits. Not imported
// from @slack/bolt/@slack/types on purpose (see file header).
// ---------------------------------------------------------------------------

export interface SlackTextObject {
  type: "mrkdwn" | "plain_text";
  text: string;
  emoji?: boolean;
}

export interface SlackButtonElement {
  type: "button";
  text: SlackTextObject;
  action_id: string;
  value: string;
  style?: "primary" | "danger";
}

export interface SlackSectionBlock {
  type: "section";
  text: SlackTextObject;
}

export interface SlackImageBlock {
  type: "image";
  image_url: string;
  alt_text: string;
}

export interface SlackActionsBlock {
  type: "actions";
  elements: SlackButtonElement[];
}

export type SlackBlock = SlackSectionBlock | SlackImageBlock | SlackActionsBlock;

// ---------------------------------------------------------------------------
// ShotState -> Block Kit
// ---------------------------------------------------------------------------

function approveRejectButtons(generationId: number): SlackButtonElement[] {
  return [
    {
      type: "button",
      text: { type: "plain_text", text: "✅ Approve", emoji: true },
      action_id: SHOT_ACTION_ID,
      value: encodeDecisionValue("approve", generationId),
      style: "primary",
    },
    {
      type: "button",
      text: { type: "plain_text", text: "❌ Reject", emoji: true },
      action_id: SHOT_ACTION_ID,
      value: encodeDecisionValue("reject", generationId),
      style: "danger",
    },
  ];
}

function reasonButtons(generationId: number, reasons: RejectReason[]): SlackButtonElement[] {
  return reasons.map((r) => ({
    type: "button",
    text: { type: "plain_text", text: r.label, emoji: true },
    action_id: SHOT_ACTION_ID,
    value: encodeDecisionValue("reject_reason", generationId, r.code),
  }));
}

function undoButton(generationId: number): SlackButtonElement[] {
  return [
    {
      type: "button",
      text: { type: "plain_text", text: "↩️ Undo", emoji: true },
      action_id: SHOT_ACTION_ID,
      value: encodeDecisionValue("undo", generationId),
    },
  ];
}

function decidedBadge(decision: "approved" | "rejected", reason: string | undefined): string {
  return decision === "approved" ? "✅ Approved" : `❌ Rejected${reason ? ` (${reason})` : ""}`;
}

function actorLabel(user: ChatUser): string {
  return user.displayName || user.id;
}

/** Header text for a shot-review message, independent of which buttons (if any) accompany it. */
export function shotStateHeaderText(
  context: { sku: string; variantIndex: number },
  state: ShotState,
): string {
  const base = `*${context.sku}* — variant ${context.variantIndex}`;
  switch (state.kind) {
    case "decide":
      return base;
    case "reject_reasons":
      return `${base}\nWhy reject?`;
    case "decided":
      return `${base}\n${decidedBadge(state.decision, state.reason)}\n— ${actorLabel(state.decidedBy)}`;
    case "reopened":
      return `${base}\nReopened for review`;
  }
}

/**
 * Full Block Kit block array for one ShotState — the complete replacement
 * body `chat.update` (or the initial `chat.postMessage`) needs, per this
 * repo's "always full state, never a delta" rule.
 */
export function shotStateToBlocks(
  generationId: number,
  context: { sku: string; variantIndex: number },
  state: ShotState,
): SlackBlock[] {
  const section: SlackSectionBlock = {
    type: "section",
    text: { type: "mrkdwn", text: shotStateHeaderText(context, state) },
  };

  let elements: SlackButtonElement[];
  switch (state.kind) {
    case "decide":
    case "reopened":
      elements = approveRejectButtons(generationId);
      break;
    case "reject_reasons":
      elements = reasonButtons(generationId, state.reasons);
      break;
    case "decided":
      elements = undoButton(generationId);
      break;
  }

  return elements.length > 0 ? [section, { type: "actions", elements }] : [section];
}

/** Initial blocks for sendGeneratedShot: image + caption + Approve/Reject. */
export function buildGeneratedShotBlocks(content: GeneratedShotContent): SlackBlock[] {
  const lines = [`*${content.sku}* — "${content.shotIdea}" (variant ${content.variantIndex})`];
  if (content.qualityNote) lines.push(content.qualityNote);

  const section: SlackSectionBlock = {
    type: "section",
    text: { type: "mrkdwn", text: lines.join("\n") },
  };
  const image: SlackImageBlock = {
    type: "image",
    image_url: content.imageUrl,
    alt_text: `${content.sku} variant ${content.variantIndex}`,
  };
  const actions: SlackActionsBlock = {
    type: "actions",
    elements: approveRejectButtons(content.generationId),
  };

  return [section, image, actions];
}

/** Plain-text fallback (Slack's `text` param) for a shot-review message — used for notifications and accessibility, alongside the `blocks`. */
export function shotFallbackText(context: { sku: string; variantIndex: number }): string {
  return `${context.sku} — variant ${context.variantIndex}`;
}
