# Tournament rosters -> rosters.json (the former Tourneys -> Rosters sheet chain)

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
  - **#2 teams** (raw name ends 14-2, 16-2 or 19-2) are tracked only for East Coast Wizards, Boston Jr Eagles
    and Shattuck-St. Mary's. They get `squad: 2` and the label "Club 16-2" (trailing U dropped). `club` is
    always the plain club name, so clubview/commits group them with the main club.
  - **Prep** stays in the label only for Shattuck's top team ("Shattuck-St. Mary's Prep 19U"). For every
    other school "Prep" is just part of the school and is not shown.
- Country of a team = most common player country.

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
- Heights are stored F-I (5-5); `5"5` typos are accepted.
- Name tags and nicknames removed from the name are kept in `tag` ("call-up", "nickname: Maddy").

## Output shape

    { "2026-27": [ { team, country, club, lvl, squad?, levels[], raw[], tourneys[],
        players: [ { pk, n, name, ry, rg, rp, dob?, school?, shot?, state?, ht?, home?, commit?, ctry?, t[], tag?, alt? } ] } ] }

`team`, `country`, and `pk/n/name/ry/rg/rp` are unchanged from the sheet-era file, so teamview keeps working.
`ry`=birth year, `rg`=grad year, `rp`=position. `ctry` appears only when a player's country differs from the team's.

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
