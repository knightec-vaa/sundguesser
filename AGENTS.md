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
- The visible score on the results share card is drawn on an HTML5 canvas
  (`drawShareCanvas()`), not plain DOM text — `#finalScore` /
  `#roundBreakdown` / `#scoreBreakdownNote` are screen-reader-only mirrors.
  Any "make a number's meaning clearer" change needs to be made in *both*
  places.
