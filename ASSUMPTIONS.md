# Assumptions

The brief is explicit that I can't interview Ellie. Here's what I'd have asked her and Maya if I could, what I did instead, and — this is the part that actually matters — what each call changed about what got built. These aren't hedges; several of them are opinions I'd defend.

## "Slack or Telegram — do you actually have a preference, or is neither in place?"

**Assumed:** Telegram. No OAuth/app-review ceremony, long-polling needs no public webhook — it's the faster real path for a one-day build, and the brief itself says either is fine.

**What it changed:** the whole chat surface is built around Telegram's specific model — inline keyboards, `callback_data` encoding, long polling. I didn't want that choice to be load-bearing forever, so the actual business logic (generation, approval, notification) talks to a platform-agnostic `ChatAdapter` interface, not to Telegram directly. Telegram is the one adapter actually deployed; Slack and Discord adapters exist and pass their own tests against the same interface, proving the architecture is portable rather than just claiming it. If Ellie's team turns out to already live in Slack, that's a swap, not a rewrite.

**My opinion:** I'd push back gently if told "it has to be Slack" at this point — Telegram's zero-webhook setup is a genuinely better fit for a small team with no existing bot infrastructure, and nothing about the product experience depends on which one it is.

## "What timezone is the team in, and what are Ellie's actual hours?"

**Assumed:** America/Los_Angeles, 9am–6pm, Monday–Friday. Pure default — the brief never says.

**What it changed:** this isn't cosmetic. Generation runs 24/7 regardless, but *notifications* are gated to this exact window — get it wrong and Ellie either gets pinged at 6am or waits until noon for shots that were ready at 8. It's a single env var to fix (`TEAM_TIMEZONE`, `WORK_HOURS_START/END`), but it's wrong by default until someone tells me the real answer, and I'd rather flag that plainly than let it look like a considered choice.

## "Is SKU actually guaranteed stable and unique, or could it drift or get reused?"

**Assumed:** yes — SKU is the durable identity key across every future drop, and I normalize it (trim + uppercase) to survive minor formatting drift in a new export.

**What it changed:** the entire idempotent-import design depends on this holding. If SKU isn't actually stable — if a future export ever reuses or reformats SKUs in a way normalization can't catch — the system will silently treat a genuinely different product as an update to an old one, or vice versa. This is the single assumption I'd most want confirmed before the 40-product drop, because the failure mode is quiet, not loud.

## "How reliable are the Photo column's links — do they ever 404 or get swapped?"

**Assumed:** not reliable enough to trust blindly. I built active validation (a HEAD/GET check plus content-type check) rather than assuming every URL in the sheet resolves to an image.

**What it changed:** a whole validation-and-caching layer that wouldn't exist if I'd trusted the column. It also means a broken photo link gets caught at import time — parked, visible, zero spend — instead of quietly wasting a Luma call three steps later. I'd rather have built a check that turns out unnecessary than skip one that turns out to matter.

## "Should approval ever go through anyone but Ellie — even Maya, even as a backup?"

**Assumed:** no. Every mutating action (approve, reject, undo, `/redo`, CSV import) is gated to one specific person. Everyone else in the chat is strictly read-only.

**What it changed:** a genuinely simple permission model — one ID, one check, everywhere — instead of a role system nobody asked for. The real cost: if Ellie's out sick during the 40-product drop, nothing moves until she's back. I extended this to CSV import specifically as my own call, not something the brief settled — meaning Maya can't kick off the drop herself even though she's the one who mentioned it as "the first real test." That's worth revisiting with them directly; it was the more defensible default given "her pick is the decision, there is no other approval step," but it's a real tradeoff, not an obvious one.

## "Does cost or quality dominate — should generation lean cheap or lean good?"

**Assumed:** cost, given Maya's explicit "every image costs money... don't burn our budget." Went with Luma's `uni-1` ($0.0434/image) over `uni-1-max` ($0.103/image).

**What it changed:** roughly 2.4x cheaper per image than the higher tier, and — this is the part I actually verified rather than hoped — real generations against real catalog products still held product identity convincingly at this tier. If quality had turned out mediocre at `uni-1`, this assumption would have been wrong and expensive to have gotten wrong; it wasn't, but that was a real risk taken deliberately, not a free choice.

## "Once something's exported to the web team, should undo still work?"

**Assumed:** no. The moment an approved image's link appears in a built `/export`, undo is refused — the web team may already have it, and quietly reversing that would desync what they think is true from what we do.

**What it changed:** an `exported_at` lock on every generation, checked before any undo. The tradeoff is real: a genuine mis-click *after* an export runs is no longer self-service — someone has to know to flag it manually. I think that's the right failure mode (a rare manual fix beats a silent desync), but it's a real constraint, not a free safety net.

## "Would Ellie actually type out why she's rejecting something?"

**Assumed:** no — she wants zero typing, maximum tap-speed, matching "chat, on my phone" literally.

**What it changed:** reject reasons are a fixed five-item tap menu, not free text. That caps how expressive the feedback loop can be (which then feeds the next `/redo` attempt as negative prompt guidance) — a rejection reason has to fit one of five buckets, or gets bucketed as "other" with no detail. If Ellie's actual rejection reasons turn out to be more varied than five categories capture, the feedback loop degrades quietly rather than breaking loudly.

## "Is the real 'shared drive folder' step something you want automated too, or does it already work fine?"

**Assumed:** it already works — the brief itself only flags steps 3-4 (freelancer batching) as broken, not steps 5-7. I built a stand-in S3/R2 bucket for output storage rather than real Google Drive integration.

**What it changed:** skipped real Drive OAuth entirely, which is a meaningful chunk of engineering time saved on a step that isn't the customer's actual problem. The cost: approved images land in a bucket, not literally in their shared drive folder — someone still moves them over, same manual step as today, just with a different source location. I think this is the correct cut given the brief's own framing, but it's worth confirming they agree the folder step genuinely doesn't need to change.
