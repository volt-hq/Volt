---
title: "Spreading Yourself Too Thin"
description: "AI lets me move so fast that my ideas never get to marinate. What Volt needs now is iteration, not more new ideas."
publishedAt: 2026-10-14
author: Jordan Hans
image: /blog/spreading-yourself-too-thin-og.png
imageAlt: "The purple Volt logo above the title Spreading Yourself Too Thin, beside dozens of faint sketched strokes that converge into one bright curved line."
tags:
  - product
  - ai
  - iteration
  - review
  - daemon
draft: false
---

> “Why, I feel all thin, sort of stretched, if you know what I mean: like butter that has been scraped over too much bread. That can’t be right. I need a change, or something.”
>
> — Bilbo Baggins, *The Fellowship of the Ring*

Lately, this is how I’ve felt working on anything. I wake up with a new idea for how a current feature, or a new one, should work. I start working on that idea and think about how it might be designed, interacted with, and exposed. It’s all fresh to me, and I can move so fast thanks to AI. Maybe too fast: it doesn’t give me room to breathe or let the idea marinate. So I end up with a half-baked implementation, because I wake up the next day with a new idea, something that’ll let me implement the last idea even faster!

Rinse and repeat.

Back in college, I had to take a digital drawing class for my MAGD minor. I’m actually a terrible artist, and all of our digital drawings first had to be done with pencil and paper. I forget what the exact assignment was, but I ended up drawing a full dragon. I looked up references and tried to mimic how the wings might look, how the body and claws were shaped, and how the neck and scales came together. Throughout the process, I erased about 95% of the lines I drew and went over them again and again. I iterated. The result was probably the best drawing I’ve ever done. I really wish I knew where that notebook ended up, because the dragon would still be on the fridge eight years later.

The same thing happened back when I was coding like normal. Is that what we call pre-AI now? When I started on a new idea, I’d first get everything out of my head and onto paper, with crazy arrows going all over the place. I’d think, “No, actually, this is how it should interact,” and move forward until I got stuck again. I guess you can call this nostalgia, but really, this is how I had to organize my thoughts.

I recently made a big architectural change to Volt that moved conversations from being hosted by the daemon or the TUI to being completely owned by the daemon. It was a long time coming. I even considered it when I first implemented the daemon, but at the time I was filled with ideas and wanted to move on quickly. So I didn’t, and handing conversations back and forth between the TUI and the daemon became the most consistent source of bugs in Volt’s live sessions. Going back and redrawing it made conversation state across devices a lot simpler.

What will make Volt strong as an agentic harness is iteration. Right now, I think one of Volt’s strongest parts is the review process, but it isn’t where I want it yet. I built a second review engine, `/swarm-review`, as an extension next to `/review`, with its own targets, its own report, and about fifteen flags. It showed me where `/review` falls short, so now I’m folding it back into `/review` as one entry point and fixing the gaps it exposed. That’s less about new ideas and more about redrawing the neck of the dragon. What I’m trying to say is that Volt has some really concrete features, but I need to refine them and smooth them out.

In my [last post](/blog/why-i-forked-pi-to-build-volt/), I said I’d keep wasting some of my time on random proofs of concept. I still will, but not at the expense of the features Volt already has. For now, that means taking the current features, exploring them, finding their weaknesses, and iterating on them.

What’s become clear is that Volt is no longer just an agentic harness; it’s becoming a workflow operator, but we can talk about that another day. I need to stop spreading myself too thin and distill my own philosophies into Volt and the companion app.
