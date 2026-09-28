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
- **How selection actually works, by tier (confirmed with Paulash, Sept
  2026)** — this is *why* the row shapes below look the way they do, not
  just a scheduling curiosity:
  - **U15** pools 15-year-olds and is normally both the start and the end
    of that year's camp path for that age group — a U15 row usually doesn't
    lead anywhere else that same year. Very rarely, a 15-year-old is
    selected straight to U18 camp instead of going through U15 at all
    (confirmed historical examples: Jane Daley, Maggie Averill) — but this
    hasn't happened for any birth year after 2009; no 2010 or 2011 birth-year
    player has skipped straight from 15-year-old to U18. Don't assume this
    path is dead going forward, but it's been dormant for two full cycles.
  - **U1617** pools two birth years (16- and 17-year-olds) and is the
    majority path into U18: a small number of players (typically returning
    WNT members or the single best 16-year-olds) get selected straight to
    U18 without a U1617 camp at all; everyone else attends U1617 camp
    first, and the best of *that* group get subsequently selected to U18
    out of it. From U18, some are further selected to WNT. This is exactly
    why a player can have a U1617 row, a U18 row, and WNT=1 all in the same
    calendar year (real example: Emilia Biotti) — each step is a further
    cut of the previous group, all resolving within one year's cycle.
  - **Practical read for anyone joining this data**: a player's full
    picture for a given year is the *union* of however many camp-tier rows
    they have that year, read in tier order (U15 or U1617 first, then U18,
    then the WNT flag on the U18 row) — never just the single highest row,
    since the lower-tier row is what shows they went through that step
    rather than being fast-tracked past it.
  - **`personkey`+`YEAR` alone is NOT a unique row identity for this file —
    the dedup key needs `CAMP` too** (`validate_camp_data.js ...
    --dupekey=personkey,YEAR,CAMP`), the same principle as provrosters.json
    needing `Province` in its key, just a different extra dimension.
    Confirmed against real 2025 data: 110 players have both a `U1617` row
    and a `U18` row that year (e.g. Addison McLay) — `personkey`+`YEAR`
    alone misflags every one of them as a duplicate.
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
- **Two separate authorities, two separate clocks, no fixed ordering between
  them — this is the core structural fact of this dataset, not an artifact
  of messy data:**
  - `Prov Camp`/`Prov Team` are decided by each individual province's own
    hockey body (OWHA, Hockey Alberta, etc.), independently of every other
    province. Timing varies by province and by year — sometimes summer,
    sometimes later — and provinces don't coordinate release schedules with
    each other or with Hockey Canada.
  - `U18 Natl Camp`/`WNT` are decided by Hockey Canada, drawing on the
    previous November's Nationals plus a standing network of regional
    scouts — a genuinely separate process from provincial selection, not
    downstream of it.
  - **The two processes are not sequential — either can resolve first.**
    Don't assume `U18 Natl Camp`/`WNT` always lag behind `Prov Camp`/`Prov
    Team`: a player can make provincial camp early summer, then separately
    make U18 Natl Camp, then get selected to WNT — all *before* that same
    player's own province has even decided provincial team. A row with
    `WNT`="1" and `Prov Team` still blank is a completely normal in-season
    state, not a data gap to chase down.
  - Because of this, don't expect the four flags on a row to fill in
    left-to-right in lockstep in either direction — any subset can be
    decided while the rest are still blank, in any order.
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
