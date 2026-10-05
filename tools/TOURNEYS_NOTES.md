# Tournament rosters -> rosters.json (the former Tourneys -> Rosters sheet chain)

> **Oct 2026 - source of truth moved.** `rosters.json` is now the editable source (live seasons 2025-26 and 2026-27; the site reads a rolling 3-season window).
> Frozen seasons (2023-24, 2024-25) live in `rosters_archive.json` (read-only; a season is added there once its data will no longer change, at the yearly rollover).
> The Teams tab on updates.html adds new rosters straight into rosters.json (default 2026-27) using the rules below. The CSV (`archive/tourneys_2023-2026.csv`)
> and the "Run it" command below are how the file was first built and are kept only as history; do NOT re-run them over rosters.json, they would overwrite later additions.
> The rules below still describe how every roster gets cleaned and merged.

Written Oct 2026 during the migration of the last spreadsheet-side raw source. Everything the
`Tourneys` tab and the `Rosters` formula used to do now lives in `tools/import_tourneys.js`.
The rules below are the single source of truth; change the tool, then this file.

## Run it

    node tools/import_tourneys.js archive/tourneys_2023-2026.csv --out rosters.json --report import_report.json --known commits.json,colrosters.json,ndc.json

Input is a CSV in the old Tourneys-tab layout (Year, Tourney, Level, #, First, Last, Name, Pos, YOB,
Grad, Committed, Team, Country, ..., DOB, School, Shot, State, Height, Hometown, NameTag). Only the
raw columns are read; the sheet's derived columns (Helper, Roster_Class, Team_Clean, Strip_tags,
OrgResolved, LevelNorm, personkey) are recomputed. The tool stops with an error if an in-window row
has a tournament name it doesn't recognise. `import_report.json` lists every flag.

## Window

Rolling: the latest Year in the data and the two before it (3 seasons). Season label = `Y-(Y+1)`,
so Year 2026 is "2026-27". 2023 and older stay only in the archive CSV.

## Tournaments

Recognised (case-insensitive): Stoney, Pittsburgh, MNRosters, NIT, Misc. Adding one means editing
`CLASS_ORDER` and `RECENCY` at the top of the tool.
Recency, earliest to latest: Pittsburgh, MNRosters, Stoney, NIT, Misc. Later wins any conflict.

## Team naming (ported from sheet columns R, S, T)

- Strip_tags: drop the age-group/tier suffix from the raw team name.
- Club: first match in `type_aliases.json` (regex against the stripped name, same normalisation as the
  sheet) gives the friendly name; no match keeps the stripped name, using the most frequent spelling
  when casing varies.
- Level: US teams use 14U/16U/19U, Canadian teams U15/U18/U22; the label follows the Country column, not the
  tournament. Raw labels are kept in `levels`.
- `team` = club + " " + level. Two exceptions, nothing else:
  - **#2 teams** (raw name ends 14-2, 16-2 or 19-2) are tracked only for East Coast Wizards, Boston Jr Eagles, Lovell Academy (19-2 = Elite; Prep is the main 19U)
    and Shattuck-St. Mary's. They get `squad: 2` and the label "Club 16-2" (trailing U dropped). `club` is
    always the plain club name, so clubview/commits group them with the main club.
  - **Prep** stays in the label only for Shattuck's top team ("Shattuck-St. Mary's Prep 19U"). For every
    other school "Prep" is just part of the school and is not shown.
- Country of a team = most common player country.
- The level label (14U/16U/19U vs U15/U18/U22) follows the CLUB's home country from the Type table, not each player's Country (boarders and mixed rosters are normal). Clubs not in the Type table fall back to the row's Country.

## Players

- personkey = `makePersonKey(Name)` then `applyPkException` (school/state/hometown context). Name is the
  source of truth; fix a wrong name in the data, never override a key.
- Duplicate rows (same player, same team-year, several tournaments) are merged field by field:
  - jersey #, position, and every other single-valued field: the most recent tournament's non-blank value
  - Grad: the latest year
  - Country: the non-US value when they differ (academies such as Lovell are sometimes harmonised to US)
  - Pos: always F, D or G (F/D -> F, D/F -> D)
  - blanks are filled from other rows, so heights, hometowns, DOB etc. are not lost
  - losing values are kept in `alt` (n, rg, rp, country); tournaments in `t`
- Grad values: a dual school-year value ("2027/28", "27/28") takes the LATER year (2028); "-PG" is dropped and the number
  kept ("2026-PG" -> 2026); values with no year at all ("PG", "GAP", "CEGEP", "tba") become blank.
- Committed school: matched to d1.json by `rosterClean.normCommitted`, then by the guess table `COMMIT_ALIASES` at the top of
  the tool (Boston U -> Boston University, MN State -> Minnesota State, ...). Non-D1 schools (D3, U Sports) are only unified
  to one spelling. Jersey-number notes typed into the column ("T #36", "was 77") are dropped and listed in the report as `commitJunk`.
- **One roster per club-season, squads included (play-ups removed).** A player listed at her own age level and also at a higher bracket of the same club in that season (a play-up entry in another tournament, e.g. Lovell's 2009 class on 16U and 19U, Stoney Creek's U18 team in the U22 bracket) is kept at the lowest level she is eligible for and removed from the higher one. Her blank fields and tournament list are merged into the kept entry. Eligibility uses the roster's birth year, else `PersonKey -> BirthYr` from `master.json` (`--master`): age = season start year minus birth year; 14U/U15 up to age 14, 16U up to 16, U18 up to 17, 19U/U22 any. A player with no birth year anywhere is left on both rosters and listed in the report as `dualUnresolved`. Removals are listed in the report as `playUpRemoved`. A player listed only at a higher level stays there.
- **Roster size check.** No team can have more than 22 players. The report lists any that do as `oversize`; each one means two rosters were merged or one was pasted twice, and is fixed in the archive data.
- Heights are stored F-I (5-5); `5"5` typos are accepted.
- Name tags and nicknames removed from the name are kept in `tag` ("call-up", "nickname: Maddy").

## Output shape

    { "2026-27": [ { team, country, club, lvl, squad?, levels[], raw[], tourneys[],
        players: [ { pk, n, name, ry, rg, rp, dob?, school?, shot?, state?, ht?, home?, commit?, ctry?, t[], tag?, alt? } ] } ] }

`team`, `country`, and `pk/n/name/ry/rg/rp` are unchanged from the sheet-era file, so teamview keeps working.
`ry`=birth year, `rg`=grad year, `rp`=position `ctry` appears only when a player's country differs from the team's.

## Data fixes made during the migration (Oct 2026)

Swapped names corrected in the data (Last First entered), garbled-encoding names repaired, run-together names split,
"CN Polar Bears" -> "CT Polar Bears", one stray header row removed, blank countries on Misc academy rows set to US,
call-up and nickname tags stripped. Players whose first name resolves through `firstNameMap.json` get the canonical key.
New Type entries: OHA Tardiff, Les Olympiques de l'Outaouais. New pkException: Caroline Doherty at The Winchendon School Prep
-> `doherty|carolinedux` (see PK_EXCEPTIONS.md).

## Known gaps

- Commit names that don't match the D1 list (U Sports schools, "Boston U", ...) are kept as typed and listed in the report.
- About 125 club names have no Type entry and pass through as written.
- The swapped-name check only runs when `--known` is given.

## Adding rosters: the Teams tab (updates.html), Oct 2026

How new rosters (a club site, a tournament sheet, several teams at once) get into rosters.json. The code is `tools/rosterIntake.js`
(parsing, matching, comparing, merging) on top of `tools/import_tourneys.js` `cleanRow` (the SAME cleaning the importer used) and
`tools/rosterClean.js`; the page fetches all three live from GitHub, like rosterClean.js. Tests: `node tools/test_rosterIntake.js`.

- **Input**: one team (defaults for Team/Level/Country under the paste box), a sheet with Team/Level/Country columns, or blocks that each start with a
  team-name line. Tab, comma, pipe or 2+-space separated; a header row is matched by synonym (Name/Player, #/Jersey, Pos, YOB/Birth Year, Grad/Class, Ht,
  Hometown, Committed, ...); without a header the columns are guessed from the values. CSV/TSV/text files can be loaded; screenshots go through Claude in chat.
- **Cleaning** (every row, no exceptions): accents stripped to ASCII, ALL-CAPS/lowercase names recased, "Last, First" flipped, nicknames in quotes/parens moved
  to the tag, AP/Injured tags stripped, personkey via makePersonKey + the school-aware exceptions, F/D/G position, F-I height, grad-year normalisation
  (dual year takes the later, "-PG" dropped, non-years blank), committed school matched to d1.json / COMMIT_ALIASES, level label by the CLUB's country, "-2" squads only
  for the four tracked clubs, Prep label only for Shattuck's top team.
- **Flags** (shown per player/team, nothing auto-fixed): swapped first/last (against every personkey known from master, rosters and colrosters), birth year after
  2020 / grad before 2020, grad not 16-20 years after birth year, too old for the level in that season (birth year from the paste, a full DOB, or master), bad heights,
  committed school not on the D1 list, one-word names, digits in names, duplicate jersey numbers, more than 22 players, a team that overlaps <50% with the team matched on file,
  a possible near-duplicate player (personkey within 2 edits of someone on that roster; NOT added by default).
- **Matching**: same club + level + squad in the chosen season. The Match box can point the paste at a different team on file or force a new team.
- **Merging** (never silent): a blank field on file is filled; a different value is shown as a conflict and used only if ticked (the old n/grad/pos goes to `alt`);
  new players are added (untick to skip); players on file but not in the paste are kept unless "Remove" is ticked; tournaments (`t`) are united. An identical team is not selected.
- **Seasons**: defaults to the newest live season (2026-27). Seasons held by `rosters_archive.json` (2023-24, 2024-25) cannot be chosen or written.
- **Saving**: Push to GitHub re-reads the newest rosters.json, re-applies the choices to it, commits with a sha check, reads back and verifies; or Download the whole file.
  The file is written exactly as `JSON.stringify(x, null, 2)` (no trailing newline unless the file had one) so `apply_corrections.js` can round-trip it.
  After a push, run the rebuild in the Master Viewer so master.json picks the rosters up (`--rebuild` now rebuilds master even with no queued corrections).
- **Not built yet**: the yearly rollover (move the oldest live season into rosters_archive.json and start the new one).

### Teams tab: preview table, column fixes (Oct 2026)
- Pasting text or loading/dropping a CSV shows the data as a table first. Each column has a dropdown with how it was read (Name, Birth date, Grad year, ...; "ignore" for notes and the like); change it when a guess is wrong. One column per field. The row's X leaves a junk row out. "Edit raw text" shows the original text again.
- The pure logic lives in `tools/rosterIntake.js` (`COLUMN_CHOICES`, `columnFields`, `columnCount`, `applyEdits`); tested in `tools/test_rosterIntake.js`.
- Teams are matched to what is on file by name/level first, then by players: when 70% of the pasted players are on one team this season, that is the team and the on-file label is kept. Canadian U18 and U22 get no age warnings (their ages overlap).

## Teams tab: one table, Notes + Decision
Each team is one table. **Notes** explains what the paste does to that row; **Decision** is what you choose (defaults in brackets).
- *fills ...*: "keep new information" checkbox [checked].
- *similar to X* (pasted name within 2 letters of a player already on the team): keep original [default] / replace with new / add as a new player / type a name. A spelling that changes the personkey is queued in `source_corrections.json` (source `tourn`, field `Name`) when you Push, and applied across every season at the next rebuild. A capitalization-only change (same key) is applied in place.
- *name or other conflict* (yellow): keep original [default] / replace with new (names also: type a name).
- *team name*: keep what is on file [default] / use the pasted one / type a name. A new team has an editable name.
- players on file but not in the paste: grey rows, "keep on roster" [checked]; unchecking removes them.
`RosterIntake.applyPlan` plan items take `near`, `names`, `noFill`, `relabel` and return `renames`; see the comment above the function and test 11 in `test_rosterIntake.js`.
