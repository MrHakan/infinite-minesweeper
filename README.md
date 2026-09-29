# Infinite Minesweeper

An endless, deterministic Minesweeper game built as a zero-backend static site for GitHub Pages.

## Play

[Open the game](https://mrhakan.github.io/infinite-minesweeper/).

- **Random world:** a new seed for each expedition.
- **Daily world:** the same deterministic seed for everybody on a given UTC day, resetting at 00:00 UTC. It uses the standard rules and community leaderboard.
- **Shared world:** enter an integer seed from `0` to `4294967295`, or open a `?seed=12345` link. Copy a world link from the seed label or world mode label in the HUD. Replaying an archived seed starts a fresh attempt.

Your starting area is safe in every mode. Changing worlds asks before replacing an unfinished run.

## Controls

| Action | Mouse / touch | Keyboard (board focused) |
| --- | --- | --- |
| Reveal | Click / tap in Reveal mode | Enter or Space |
| Quick open an open number | Click / tap in either mode when neighboring flags match | Enter or Space |
| Flag / unflag | Right click, long press, or tap in Flag mode | F |
| Select cell | Click / tap | Arrow keys |
| Pan | Drag | Selection scrolls into view |
| Zoom | Wheel, pinch, + / − buttons | + / − |
| Return to origin | Crosshair button | Home |
| Return to last cleared cell | Arrow button | — |
| Pause | Back button | Escape |

The board settings panel has optional sound and grid lines. Finished runs include a field inspection view and replay sharing.

## Gameplay

- The board has no fixed edge or final level.
- The run begins in a guaranteed-safe origin zone.
- New cells must be revealed from the explored frontier, so progress expands continuously instead of teleporting across the world.
- One mine ends the run.
- Clicking an already-revealed numbered cell performs classic Minesweeper **chording**: when its adjacent flag count matches the number, every other covered neighbor opens at once. Incorrect flag placement can still expose a mine and end the run.
- Active runs, compact chunk state, settings, and up to 100 finished runs are stored in `localStorage`. The archive summarizes the retained runs and displays the most recent 12.
- Runs pause in menus, help dialogs, and hidden tabs. Autosaves do not reset input timing, so the action replay and final result use the same active time.
- Existing v1 saves, chord actions, mine layout, scoring and replay codes remain compatible. A run saved by an older version can resume in the new interface.
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

## Development

No build step or runtime dependencies are required.

```sh
python3 -m http.server 8080
npm test
```

Open `http://localhost:8080`. Tests cover chording, compact action encoding, session timing across autosaves and pauses, replay verification, UTC daily seeds, seed validation, camera recovery, and chunk persistence.

The renderer caches viewport dimensions once per frame and uses constant-cost live score counters. Final flag accuracy is computed only when a run ends, rather than scanning explored chunks during every pan or HUD update.

## GitHub Pages

`.github/workflows/pages.yml` runs tests on pull requests and pushes, then deploys only the static application files after validation. It deploys the static repository with the official Pages actions. If Pages has never been enabled for this repository, set **Settings → Pages → Source → GitHub Actions** once; subsequent pushes to `main` deploy automatically.
