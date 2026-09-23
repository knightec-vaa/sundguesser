# Agent instructions for SundGuesser

## CRITICAL: never change the rules for an already-published day

Once `data/games/<date>.enc.json` exists and has been published (its date is
in `data/manifest.json`), that day's locations, round order, difficulty
flags, and available modifiers are **frozen forever**. Players' scores for
that day must stay reproducible/consistent no matter how the game evolves
later — "everyone plays the same game every day" is the core promise of this
project, and that includes the *same day* being the same game for anyone who
plays or replays it, forever, not just for players on the day it launched.

**Do NOT:**
- Regenerate/backfill an already-published game file (`tools/generate_game.py
  --force` on an old `--date`) just to add a new field or pick up a scoring
  change. The location pool's used/unused state drifts every single day a
  new game is generated, so a re-run can silently choose *different*
  locations for that date even though the RNG seeding is deterministic per
  date — invalidating every score already earned that day.
- Add client-side logic that changes a round's rules retroactively based on
  "whatever version of the code is running today" rather than data that was
  actually embedded in that day's own published game file.
- Recompute a player's saved score. Scores are written once
  (`saveFirstScoreIfMissing`) and never touched again, even as scoring rules
  evolve — see the comment there.

**DO:**
- Gate any new *day-level* mechanic (locations, difficulty, available
  modifiers, etc.) by data embedded in the game file itself at generation
  time (`tools/generate_game.py`), seeded by date (`random.Random(f"{date}:
  ...")`) so it's reproducible but still varies day to day. The mere
  presence/absence of that field on old vs. newly-generated files is what
  naturally scopes a new feature to "from now on" — no explicit cutoff-date
  constant needed anywhere.
- Keep scoring/state changes purely additive on the client: old saved score
  records (`localStorage`) must always read back safely (`|| 0`, `|| []`,
  etc.) even when they're missing brand-new fields, and old *published game
  files* must always read back safely (e.g. `game.modifier || null`) even
  when they're missing brand-new keys.
- When in doubt, ask: "if I ran this exact code against a game file from
  three weeks ago, would anything about that day change?" If yes, redesign
  it so the answer is no.

### Concrete example: the final-round modifier

`game.modifier` (`null`, `"double"`, `"hard"`, or `"quick"`) is decided
**once**, server-side, in `tools/generate_game.py`'s `pick_daily_modifier()`,
and baked into that day's encrypted game file at generation time — not
computed live from the client's current code (that used to be a bug: an
earlier version triggered the offer client-side from an in-game hot streak,
which meant replaying an *old* published day with newer client code could
offer a modifier that simply didn't exist when that day was originally
played). Days published before this feature existed just have no
`"modifier"` key; `script.js` reads that back as `null` and
`shouldOfferFinalModifier()` always returns `false` for them, no matter how
the client evolves later. Do not "fix" old game files to add this field.

## Other established patterns worth knowing

- `roundIsHard` / `roundHardFlags` (a deterministic, day-fixed difficulty
  flag baked in at generation time, used for the "Hard Round Hero" medal and
  hiding the area hint) is unrelated to the opt-in final-round "Hard Round"
  *modifier*. Keep them separate — different mechanics, similar name.
- Medal bonuses and modifier bonuses are deliberately **not** capped at 100
  or floored at 0 — stacking them past 100 is what unlocks/escalates the
  SUNDMASTER title and celebration. This is intentional, not a bug.
- **SUNDMASTER is tiered (0-3), not a single on/off state.**
  `sundmasterTier(score)` in `script.js` maps score ranges to a tier
  (`>100` → 1 "🏆 SUNDMASTER!", `>130` → 2 "👑 SUPER SUNDMASTER!!", `>170` →
  3 "🌈 ULTRA SUNDMASTER!!!"), driving both `SUNDMASTER_TITLES[tier]` and
  the `.sundmaster` / `.sundmaster-tier2` / `.sundmaster-tier3` CSS classes
  on `#finalBox` (each gated to `tier >= 1`/`2`/`3`, so classes stack).
  `currentIsSundmaster` (bool) and `currentSundmasterTier` (0-3) are both
  set together, following the same explicit-state pattern as
  `currentShareScore` — never inferred at render time, always assigned by
  whichever flow (`nextRound()` live finish, or `showSavedScoreOverlay()`
  replay) currently owns the display.
- The visible score on the results share card is drawn on an HTML5 canvas
  (`drawShareCanvas()`), not plain DOM text — `#finalScore` /
  `#roundBreakdown` / `#scoreBreakdownNote` are screen-reader-only mirrors.
  Any "make a number's meaning clearer" change needs to be made in *both*
  places.
- Once the pool of unused locations runs low, `generate_game.py` starts
  reusing previously-used locations rather than failing outright — but
  picks them via a date-seeded RNG sample from a widened "oldest-used"
  window (not a strict oldest-N cut), so repeat cycles don't all play out
  identically. Reusing locations does not affect an already-published
  day's frozen data — it only governs what a *newly generated* day is
  allowed to draw from.

## Daily automation pipeline (GitHub Actions)

Three workflows keep the game running with no manual intervention, chained
by `workflow_run` (not shared schedules) specifically to avoid races and to
make sure the most important job — publishing the day's game — can never be
blocked or delayed by the other two:

1. **`daily-game.yml`** ("Generate daily game") — the only workflow with
   its own cron: a primary run at `5 0 * * *` (00:05 UTC, right after the
   UTC day rolls over — `generate_game.py` uses UTC `date.today()`) plus a
   backup run at `23 3 * * *` in case the primary is delayed or skipped
   (GitHub's schedule triggers are best-effort and can lag by hours,
   confirmed in practice). Safe to run twice a day: `generate_for_date()`
   no-ops (exit 0) if the day's game file already exists without `--force`.
   Also self-heals gaps: with no `--date`, it backfills every missing day
   between the manifest's latest published date and today, not just
   literally "today" — so a long scheduling delay can never silently and
   permanently skip a day. **Never** pass `--force` on an already-published
   date (see the CRITICAL section above).
2. **`fetch-locations.yml`** ("Fetch new locations") — triggered by
   `workflow_run` on "Generate daily game" completing (any conclusion),
   instead of its own schedule, so it can never race with game generation
   over writing `data/`. Has its own same-day guard (checks `git log` for
   today's UTC-dated "chore: auto-fetch..." commit and skips if found) so
   it can't double-fetch if "Generate daily game" happens to run twice in
   one day (e.g. primary + backup both firing). Manual `workflow_dispatch`
   of this workflow always runs regardless of the guard.
3. **`deploy.yml`** ("Deploy to GitHub Pages") — also triggered
   independently by `workflow_run` on "Generate daily game" succeeding
   (`GITHUB_TOKEN`-authored pushes from `daily-game.yml` don't trigger
   `push` events, hence `workflow_run` instead), in parallel with
   `fetch-locations.yml`, not chained after it.

All three `workflow_run` listeners fire off the *same* upstream event, so
game generation itself never waits on either of the other two — a stuck or
buggy fetch/deploy run can't delay tomorrow's game.

## How to actually verify changes work (don't just read the code)

Both the client and the automation pipeline have caused real, subtle bugs
that only surfaced by *running* things, not by reasoning about the code —
see the replay-scoring bug and the stray-future-game-file bug earlier in
this project's history. Static review (syntax checks, reading diffs) is not
enough on its own; always follow up with one of these depending on what
changed:

**Client-side changes (`script.js`/`effects.js`/`style.css`/`index.html`):**
- Run a local dev server (`LOCATIONS_KEY=$(cat secrets/key.txt) python3
  tools/dev_server.py <port>`) and drive it with a headless Chromium
  instance over raw CDP (no Playwright available in this environment) —
  connect via WebSocket, `Runtime.evaluate` to call game functions directly
  (e.g. force a specific score, call `nextRound()`/`showSavedScoreOverlay()`
  /`drawShareCanvas()`), and assert on both the resulting DOM state (globals
  like `currentIsSundmaster`, text content) and that canvas-drawing calls
  complete without throwing.
- Specifically test the *replay* path, not just first-playthrough: play a
  day once, then again with different inputs, and confirm the share card
  reflects the fresh attempt while `record.score` (the frozen official
  value) and the "Nth TRY" stamp still show the original. A bug here is
  easy to introduce (reading the wrong variable) and easy to miss if you
  only ever test a fresh first playthrough.
- Confirm old data still reads back safely: simulate a `localStorage`
  record and a game file missing whatever new field you just added, and
  check nothing throws or silently misbehaves (`|| 0`, `|| null`, etc. must
  actually be hit, not just present in the code).
- Clean up: kill the dev server / Chromium processes and delete any temp
  test scripts when done. `kill <PID>` only — no `pkill`/`killall` in this
  environment.

**`tools/generate_game.py` / pool / manifest changes:**
- Never test destructively against the real `data/` in this repo — pool
  used/unused state and the manifest are live production data. Copy the
  repo (or just the relevant `tools/`, `data/`, `secrets/` files) to a
  throwaway directory (e.g. `/tmp/sg_test`) and run scenarios there:
  normal no-op when today's game already exists, explicit `--date --force`,
  a simulated multi-day scheduling gap (backfill), and pool exhaustion
  (reuse path). Delete the temp directory afterward.
- After any change to what gets baked into a game file, decrypt a freshly
  generated test file and inspect the actual JSON — don't just trust that
  the code "should" produce the right shape.

**GitHub Actions workflow changes (`.github/workflows/*.yml`):**
- YAML-syntax-check every changed workflow file
  (`python3 -c "import yaml; yaml.safe_load(open(f))"` per file) before
  considering it done — a bad indent silently breaks the whole workflow on
  the next trigger with no local warning.
- Structural reasoning about `on:`/`if:`/`workflow_run` conditions is not
  sufficient proof it works — GitHub Actions triggers have real quirks
  (e.g. `GITHUB_TOKEN`-authored pushes don't fire `push` events; scheduled
  triggers can silently lag hours behind their cron time on low-traffic
  repos). After such a change is pushed, use the GitHub API/MCP tools
  (`actions_list` → `list_workflow_runs`, `list_workflow_jobs`,
  `get_job_logs`) to confirm, on a real run: which trigger fired it, which
  steps actually ran vs. got skipped, and that the expected downstream
  workflow(s) fired afterward with the expected outcome (e.g. a same-day
  guard actually skipping a duplicate run, not just existing in the YAML).
  Don't declare a workflow change verified until you've seen it behave
  correctly against a real GitHub Actions run, not just a sandboxed
  simulation.

## Commit message convention

Keep every commit message to a **single line**: one lighthearted/funny word
or short phrase, no explanatory body, no bullet list of what changed (e.g.
`mango :D`, `kiwi :D`, `:)` — see `git log` for the established style).
**Do not** write a multi-paragraph description of the change into the
commit message, even if the change itself is substantial or nuanced — that
kind of detail belongs in this file (AGENTS.md) or in conversation with the
user, not in the commit body. If a commit needs the "why" written down
somewhere permanent, that's a sign it should be captured here instead.
