# Luma Take-Home — Forward Deployed Engineer

Modern engineering is about directing leverage — tools, judgment, taste — toward real outcomes. This take-home is designed around that.

There's one problem, and it isn't yours — it's a customer's. That's the job. You have \~1 working day.

**You must use AI coding tools** — Claude Code, Cursor, Codex, whatever you prefer. The problem is scoped so that AI is necessary to ship something real in a day. We want to see how you direct the tools: how you plan, how you course-correct, what you accept, and what you push back on.

---

## The Situation

A six-person home-goods brand sells about 300 products through their own site. Every product has one photo: the product on a white background. **Their problem: they want styled photos — the product in a real scene — and they can't get them made fast enough to matter.** Product pages convert better with them, social needs them, the Q4 campaign runs on them. Most products have never gotten one.

**Their process today, start to finish:**

1. The catalog is one shared spreadsheet, one row per product (SKU, name, color, price, a link to the white-background photo).
2. When someone wants a styled shot, they write what they picture in the row's **Shot Idea** column — "morning kitchen counter, steam, warm light," "holiday mantel with evergreen." That's a request. There are sixteen in the sheet right now, some months old.
3. Two or three times a year, Ellie (she runs product content) compiles the waiting requests into a list for a freelance photographer.
4. Weeks later, the freelancer sends back a contact sheet — a few candidate shots per product.
5. Ellie picks in the team group chat — "that one," "no, too staged" — assume Slack or Telegram, whichever you prefer. Her pick is the decision; there is no other approval step.
6. Approved finals go into a shared drive folder.
7. The web person uploads from that folder to the site, roughly weekly.

That's the whole process. It works for them — except steps 3 and 4, which happen so rarely and so slowly that the Shot Idea column is where requests go to wait. "Done," for a request, means: **2–3 approved images matching the shot idea**, in the drive folder, on the product page.

Maya (the founder) exported the sheet and sent it over — *"this is where we are as of today"* — and that export is in this repo.

Last quarter they trialed a creative-automation tool with a beautiful dashboard. Nobody logged in after week one. When Maya brought up trying AI generation, Ellie's answer was: **"Fine — but I'm not logging into another tool. If I can't do it from the chat, on my phone, it doesn't exist."**

Maya's ask, verbatim:

> "Can the AI just make the shots people put in the sheet? And Ellie approves them in the chat, on her phone, like she already does. She's not going to change how she works — we tried that. Also every image costs money, right? So don't burn our budget on stuff she'll reject. I'd want to see where things stand without having to ask Ellie. Oh — and we have a 40-product drop landing next month. I'd love for that whole drop to launch with styled shots, as the first real test."

**Design and build the product that turns this team's shot ideas into approved, published images — inside the tools they already use.**

---

## What You Have to Work With

**Maya's export is in this repo**: `data/catalog.csv` (a sample of the full 300). The Photo column links to each product's white-background shot. Treat the file as what it is — a customer's data handoff, quirks included. How results and status get back to the team is yours to design; an updated export at the end is fine, and nobody is asking for live sheet sync.

There's more worth building here than fits in a day — deciding what matters most is part of the assignment.

---

## Tips

The candidates who do best don't start by building — they start by getting sharp on the problem. This team told you exactly how they work and exactly what they rejected. Read it again before you write a line of code.

You can't interview Ellie. Where the brief is silent, make an assumption, write it down, and keep moving — that's the job too.

---

## What We're Looking For

We want real, working software — not a prototype, not a toy. You'll focus on a slice of this, but the slice should actually work and be something you'd put in front of this team on Monday. The AI writes the code; you own the decisions.

- **Product judgment inside someone else's constraints** — the experience you design within the chat and the sheet, not around them
- **Clarify before solutioning** — the questions you'd ask, the assumptions you chose, and how they shaped what you built
- **Prioritization** — what you cut, and whether you cut by value or ran out of time
- **How you use AI tools** — how you directed them, where you pushed back, where your judgment shaped the result
- **How you communicate** — your video is a first-class deliverable here, not a formality

---

## What to Deliver

### 1. Working software
 
Build your solution directly in this repo. It should run — really run, not demo-run.

**Your product must be deployed.** Running somewhere real — Railway, Fly, Vercel, a VPS, wherever, and that's what your video demos: the deployed product, not localhost. Put the live URL and/or the chat workspace in APPROACH.md; if we can join the channel and try it ourselves, even better.

New exports will keep coming — the drop is next month — so a fresh CSV (same columns, new products, new photo URLs) needs a way into your system. How that entry point works is your design; **show it working in your video.**

Your challenge archive includes a `.env.local` with your Luma API key for generation — API docs at [docs.agents.lumalabs.ai](https://docs.agents.lumalabs.ai). It's gitignored; keep it that way. If you run short on credits, send us a note. Any other APIs you need are up to you.

### 2. ASSUMPTIONS.md

The questions you would have asked this team if you could, the assumption you proceeded on instead, and what each assumption changed about what you built. Strong submissions have opinions here — this is not a form to fill in.

### 3. APPROACH.md

- What you built and why
- Key decisions and tradeoffs
- **Scope ledger:** what's in, what's out, what's next — each with the reasoning
- **Unit economics:** what one approved image costs in dollars and minutes, and what changes at 10× the catalog
- What breaks first under pressure

### 4. Video walkthrough

Record a \~8 minute video, in two parts. **First 3 minutes: present to this team** — no jargon, their language, their problem; would Ellie watch it and want this? **Then: the engineering walkthrough** — architecture, decisions, what you'd do next.

**Demo the real thing, live** — the actual chat, real generations coming back, an approval landing where it lands. The video is how we experience your product, so treat the demo as load-bearing, not a screen recording formality.

We are explicitly evaluating how you present. Forward deployed engineering is partially this.

**Paste your video link (Loom, Google Drive, YouTube, etc.) into** `video.md`**.**

### 5. AI session history

Your AI session logs (Claude Code, Codex, Cursor) are packaged automatically when you run `./submit.sh`. If you used other AI tools (ChatGPT, etc.), export those conversations and include them in your repo before submitting.

This is a required deliverable. We review your AI interaction to understand how you work — how you plan, iterate, and direct the tools.

---

## Getting Started

```bash
# 1. Extract the challenge archive you downloaded
tar xzf challenge.tar.gz && cd *eng-take-home*

# 2. Create your own private repo and push to it
git init && git add -A && git commit -m "initial"
```

Now build your solution. Commit and push as you go.

---

## Submitting

When you're ready, run the submit script from your repo root:

```bash
./submit.sh
```

This handles everything: packages your AI session history, commits and pushes your latest changes, grants reviewer access, and registers your submission. You'll see a confirmation when it's done.
