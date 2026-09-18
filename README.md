# Infinite Minesweeper

An endless, deterministic Minesweeper game built as a zero-backend static site for GitHub Pages.

## Gameplay

- The board has no fixed edge or final level.
- The run begins in a guaranteed-safe origin zone.
- New cells must be revealed from the explored frontier, so progress expands continuously instead of teleporting across the world.
- One mine ends the run.
- Active runs, compact chunk state, settings, and local run history are stored in `localStorage`.
- Rendering uses one `<canvas>` and redraws only when dirty; there is no DOM node per cell and no continuous animation loop.
- World state is stored as two 256-bit masks per touched 16×16 chunk. Memory grows only with genuinely explored territory rather than viewport movement.

## Community leaderboard

The leaderboard reads public comments from this Gist:

https://gist.github.com/MrHakan/02990dee7192a0419aeb0b208b54b02d

When a run ends, **Share with people** copies an `IM1...` replay code and opens the Gist. Paste the code as a comment. The Stats screen fetches Gist comments, extracts codes, deterministically replays every action, recomputes the result, and only ranks matching runs.

Filters include score / cleared cells / survival / exploration radius, time window, player search, and best-run-per-player deduplication.

## Anti-cheat model

This is a static GitHub Pages app, so no browser-only technique can make cheating impossible: a determined user controls their own JavaScript runtime. The project therefore avoids fake “DevTools detection” and instead raises the cost of casual manipulation:

- leaderboard entries contain the compact action replay, not a trusted raw score;
- posted results are recomputed from deterministic game rules;
- the share payload includes an integrity digest;
- replay validation rejects impossible frontier jumps, post-death actions, malformed actions, result mismatches, and sustained machine-speed click streams;
- gameplay state is module-scoped rather than attached to `window`;
- a restrictive Content Security Policy blocks inline/injected script execution in the normal page context;
- leaderboard parsing is bounded to protect the client from oversized or hostile comments.

A server-authoritative leaderboard would be required for strong anti-cheat guarantees.

## GitHub Pages

`.github/workflows/pages.yml` deploys the static repository with the official Pages actions. If Pages has never been enabled for this repository, set **Settings → Pages → Source → GitHub Actions** once; subsequent pushes to `main` deploy automatically.
