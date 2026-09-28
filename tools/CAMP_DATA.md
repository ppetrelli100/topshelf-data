# Camp & national-team pipeline data — semantics

This document is the home for the parts of `ndc.json` and `provrosters.json`
that aren't about name-cleaning (that's `tools/rosterClean.js` and
`ROSTER_CLEANUP.md`) — the domain semantics of how these two files represent
a player's progress through a national development-camp/team pipeline. Both
files get joined into `commits.json`/`master.json` by `personkey`, and both
get read by `camps.html`, `playerview.html`, and `commits.html` on the
TopShelf site. Written so an AI or a person picking this up cold doesn't
have to reconstruct it from git blame — this replaces the header comments
that used to live in `ndc_static.js`/`provrosters_static.js` before those
were retired in favor of live-fetched JSON.

## Shared conventions

- **One row per player-per-year.** A player's camp/team/selection status for
  a given year lives on a single row, as flag columns — not as separate rows
  per event. This is deliberate: it's what lets a season's data get filled
  in gradually as real-world decisions land at different times (see below)
  by editing that one row in place, rather than needing to append and later
  reconcile multiple rows.
- **personkey** (`lastname|firstname`, lowercase, accents flattened) is the
  join key against `commits.json`/`master.json`/`colrosters.json`. Built by
  `tools/rosterClean.js`'s `makePersonKey()`, same as everywhere else in the
  pipeline.
- **Validate every rebuild.** `tools/validate_camp_data.js` runs
  `makePersonKey`/`computeSwapIssue`/`checkYearSanity` from
  `rosterClean.js`, plus a same-row-identity duplicate check, against a
  known-personkey corpus built from `master.json`/`commits.json`/
  `colrosters.json`. Run it on every re-paste, not just once — these sources
  get updated by hand throughout the season, and the same error shapes
  (mistyped name breaking the join, an accidental re-paste, a birth/grad
  year typo) recur every cycle. See its own header for usage.

## ndc.json — USA Hockey National Development Camps

- Row shape: `YEAR, CAMP, WNT, NAME, TEAM, POSITION, DOB, BIRTHYR, GRAD,
  HT, WT, HOMETOWN, STATE, DISTRICT, personkey, Helper` (`Helper` =
  `personkey + "|" + YEAR`, the row-identity key for dedup purposes).
- `CAMP` is exactly one of `U15` / `U1617` / `U18` — there is no `WNT` camp
  value. `WNT` is a separate 0/1 flag that only ever applies to a `U18` row
  (a player named to the WNT roster out of that year's U18 camp).
- **Cascading announcement schedule, every summer**: U15 → U18 (a first,
  smaller wave) → U1617 → the rest of U18 → WNT (announced last, out of
  that year's U18 group). This means an in-season export can have some
  players' current-year row fully populated and others still
  blank/in-progress — that's expected, not a data gap. `ByYear` on the
  sheet-side turns this into the display progression label (`W`/`X` helper
  columns: tier rank, then a label like "U18→WNT").
- **A player can have two rows in the same YEAR, one per camp tier** — this
  is a direct consequence of the cascading schedule above, not an error:
  a player can be named to both that year's U1617 camp and, separately,
  that year's U18 camp (confirmed against real 2025 data: 110 players have
  exactly this, e.g. Addison McLay has a `U1617` row and a `U18` row both
  dated 2025). **`personkey`+`YEAR` alone is NOT a unique row identity for
  this file — the dedup key needs `CAMP` too** (`validate_camp_data.js
  ... --dupekey=personkey,YEAR,CAMP`), the same principle as
  provrosters.json needing `Province` in its key, just a different extra
  dimension.
- DISTRICT has case-inconsistent raw values in the source; consuming pages
  normalize against a canonical 12-item list (`DISTRICT_ORDER`/
  `normDistrict()` in `camps.html`) rather than the raw value.

## provrosters.json — Canadian provincial camp/team + national selection

- Row shape: `Year, Province, Prov Camp, Prov Team, U18 Natl Camp, WNT,
  Name, Position, Shoots, Height, Weight, DOB, BirthYr, Grad-EST, Home
  City, Home Province, Home Country, Team, League, personkey, personkey
  helper, U16 Prov`. (`personkey helper` = `personkey + "|" + Year`.)
  Three sheet-side helper columns — `Helper2` (tier-rank string, e.g.
  `"4|WNT-C"`), `LatestYr`, `Progression` (display string, e.g.
  `"BCcamp→TmBC"`) — are intentionally left out of the JSON: every
  consuming page already recomputes the same tier-rank/progression logic
  client-side from the raw flag columns (`LEVEL_RANK` in `commits.html`,
  the parallel logic in `camps.html`/`playerview.html`), same convention as
  NDC's `Helper`-keyed rows not carrying `ByYear`'s derived columns either.
- **`Prov Camp`, `Prov Team`, `U18 Natl Camp`, `WNT` are each EITHER `"1"`
  (made it), `"0"` (did not — known, season complete), OR blank (not yet
  decided).** Blank is not the same as `"0"` — never treat them as
  equivalent. A literal `"0"` in `Prov Team` is a real "tried out, didn't
  make it" fact, not "no team level exists" — this exact confusion was a
  real, previously-fixed bug (`camps.html`/`commits.html` used to treat a
  bare-truthy check as "has a team", which read a literal `"0"` as a team).
- **Two separate authorities, two separate clocks — this is the core
  structural fact of this dataset, not an artifact of messy data:**
  - `Prov Camp`/`Prov Team` are decided by each individual province's own
    hockey body (OWHA, Hockey Alberta, etc.), independently of every other
    province. Timing varies by province and by year — sometimes summer,
    sometimes later — and provinces don't coordinate release schedules with
    each other or with Hockey Canada.
  - `U18 Natl Camp`/`WNT` are decided by Hockey Canada, late summer every
    year, drawing on the previous November's Nationals plus a standing
    network of regional scouts — not directly on that same year's
    provincial-team selection. This is a genuinely separate, later-arriving
    process, disconnected from the provincial one.
  - Because of this, don't expect the four flags on a row to fill in
    left-to-right in lockstep, and don't treat an early-season export's
    blank `U18 Natl Camp`/`WNT` on an otherwise-complete row as unusual —
    it's the normal state until Hockey Canada's own cycle catches up.
- **`U16 Prov` is Ontario-only, camp-only** (no team level exists at U16 in
  any province — tracked in Ontario specifically because it has enough
  depth to be worth capturing, unlike other provinces at that age). A
  U16-only row has every U18-level flag (`Prov Camp`/`Prov Team`/`U18 Natl
  Camp`/`WNT`) as `"0"`, since Ontario's U16 window (14–15yo) and the U18
  window (16–17yo) never overlap for the same player in the same year —
  gate any "did this player reach provincial camp" check on the real flag,
  falling back to `U16 Prov` only when none of the U18-level flags are set.
- **A player can legitimately have two rows in overlapping years** — e.g. a
  billet situation where a player is entered under two different provinces
  (confirmed real case, not a data error: Hayley McDonald, Manitoba and
  Ontario Red). This is the one case where the one-row-per-player-per-year
  convention above has a genuine exception, and it's easy to mistake for
  the OTHER kind of duplicate — an accidental re-paste of the exact same
  province+year (a real bug, found and fixed during the Sept 2026
  migration). **The dedup check in `validate_camp_data.js` keys on
  personkey+Year+Province specifically so it can tell these apart**: same
  province+year twice is flagged as a likely paste error, same year but a
  *different* province is flagged separately for a human to confirm it's a
  real multi-province case rather than either auto-dropped or silently
  ignored.
