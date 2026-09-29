# ep.json — EliteProspects player reference

`ep.json` (27,134 rows, in `topshelf-data`) is the full EliteProspects female
player export, not a pre-filtered subset. Earlier work (pre-migration, on the
Sheet) used a ~3,700-row subset limited to players already matched to
Master, because Sheets had real row/size constraints. That constraint
doesn't apply to a GitHub-hosted JSON, so the full set is kept as the
canonical reference — new matches against Master surface automatically as
Master grows, without anyone re-running a match-and-trim pass by hand.

This is a one-way lookup/reference source, not a primary feed: used to fill
gaps (e.g. DOB) when nothing else has the answer, not as an authoritative
value that overrides other sources. EP is usually good with canonical names
but not perfect — no manual personkey cleanup has been done here, unlike
some other sources.

## personkey and collisions

personkey is built the same way as everywhere else
(`tools/rosterClean.js`'s `makePersonKey`), from EP's own separate
`first_name`/`last_name` fields — no Last-First swap risk here, unlike
sources parsed from a single pasted Name string.

At 27k rows, personkey collisions are expected and normal, not paste
errors. As of the Sept 2026 build:
- **399 distinct personkeys are shared by more than one row (824 rows
  total).** Split into two different shapes:
  - **224 groups share the same name AND the same year_of_birth** — almost
    certainly duplicate EP profiles for one real person (EP does create
    dupes), not two different people.
  - **175 groups share a name but have DIFFERENT birth years** — genuinely
    different real people who collide on `lastname|firstname`.
- Of those 175 different-year collision groups, checked against
  `master.json`'s own BirthYr for the same personkey (Sept 2026 snapshot):
  - **70 are resolvable** — master has that personkey and exactly one EP
    candidate's year_of_birth matches master's BirthYr, so that candidate is
    confirmed as the HockeyFile player.
  - **11 are in master but still ambiguous** — master has the personkey but
    its BirthYr is blank, or doesn't uniquely match any EP candidate.
  - **94 have no master record at all** — pure EP-side collisions between
    unrelated people, nothing to resolve.
  - Of the 224 same-year (likely-duplicate-profile) groups, 32 personkeys
    are also in master, but master's BirthYr can't distinguish between two
    EP ids that already share a birth year — no way to pick a "canonical"
    id from master data alone in that case.

**Practical rule for any future join/lookup against ep.json: match on
personkey + year_of_birth together, never personkey alone.** A bare
personkey lookup will sometimes silently return the wrong person.

## Source priority is NOT fixed across all fields

On the old Sheet, precedence between sources was a fixed rule (e.g. always
prefer NDC over EP for a given field) because the Sheet's IFS-chain formulas
needed one static order. That doesn't have to carry forward as a blanket
rule now that this logic can live in scripts: which source wins for a given
field can be situational — e.g. EP might be trusted for DOB specifically
when nothing else has one, but a different source might be preferred for
position, height, or team, and the right answer may vary by what else is
known about that specific player (state/country, whether another source's
birth year already narrows the EP collision down to one candidate, etc.).
Don't assume "EP loses to X" (or wins) as a universal rule when building
whatever eventually joins ep.json into Master or elsewhere — the priority
decision belongs at the point where a specific field's merge logic gets
built, not baked into ep.json itself.
