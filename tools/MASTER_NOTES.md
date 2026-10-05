# master.json rebuild: how it works and every rule we settled (Oct 2026)

`tools/build_master.js` rebuilds the Master record (one row per player) from the raw JSON files in this repo, replacing
the spreadsheet Master tab. This file is the record of HOW each field is picked and WHY. Read it before changing a pick rule.
Config lives in `tools/master_picks.json`; per-player manual fixes live in `overrides.json`.

Status: PROMOTED Oct 3, 2026. `master.json` is now the output of this build (12,565 players). The final spreadsheet-era file is kept as
`master_last_hockeyfile.json` (12,590 players, byte-identical to the old master.json; never delete it, it is the College `legacy` source and the diff baseline).
`master_sources.json` is the provenance sidecar for the new master.json and lives beside it. Regenerating: run the build, review `master_diff.json`,
then copy `master_candidate.json` over `master.json` (the build never writes master.json itself).

## Run it

    node tools/build_master.js [--repo dir] [--out master_candidate.json] [--sources master_sources.json] [--diff master_diff.json] [--picks tools/master_picks.json]

Outputs (all regenerated on every run):
- `master_candidate.json`  the rebuilt Master (array of player rows, same shape as master.json)
- `master_sources.json`    provenance sidecar (below). master.json rows are never changed to carry provenance.
- `master_diff.json`       per-field comparison against the existing master.json + per-source calibration.
The console prints a same / differ / master-only / candidate-only table per field. master.json and master_sources.json are committed; master_candidate.json and master_diff.json are scratch (do not commit).

## Inputs

commits.json, commits_d3.json, ndc.json, provrosters.json, nepsac.json, ccm68.json, ma.json, colrosters.json (season > school > players),
rosters.json (editable, live seasons, the rolling 3-season window the site reads) and rosters_archive.json (frozen seasons, read-only), flattened to player level by
`import_tourneys.js flattenPlayers` (a season held by the archive is taken from the archive, so none is counted twice), ep.json (EliteProspects, gap-filler only), type_aliases.json, firstNameMap.json,
overrides.json, intl_wnt_o.json (optional extra WNT-O keys), regionals.json, master_last_hockeyfile.json (the old spreadsheet-era master: used ONLY for the College fallback and for the diff).

## Player universe and join key

- Join key = `personkey` (`lastname|firstname`, lowercase letters only) from `tools/rosterClean.js` makePersonKey, collisions via
  `firstNameMap.json` pkExceptions (see PK_EXCEPTIONS.md).
- A player is in the Master if any of these sources has them: commits, ndc, prov, nepsac, tourn, ccm, ma (`picks.universe`).
  colrosters-only players (about 1,300) and ep-only players are NOT in the universe (colrosters/ep only fill fields).
- `picks.dropKeys` removes junk keys (currently `fromand|goal`, a tourneys parsing artifact).
- Candidate has 12,565 players; old master has 12,590. 12,476 in both, 114 only in the old master, 89 only in the candidate.

## Provenance sidecar (master_sources.json)

`{ personkey: { Field: { src, alts:[[src,value],...], agree?, prec?, suspect?, conflict?, ambiguous?, note?, birthYrMismatch?, from? } } }`
- `src` = where the picked value came from (ndc, commits, tourn, prov, ccm, ma, nepsac, d3, colrosters, ep, override, legacy,
  rosters, campRank, state, dob-year, none).
- `alts` = what the other sources said when they differed. Sources that matched the pick are not listed there; `agree` lists
  supporters for the weighted votes (DOB, Position).
- Use it for auditing: "this grad year looks wrong, where did it come from?" -> look up the personkey and field.

## Source trust (your words)

NDC is weighted heaviest: players enter and care about their own data. ProvRosters and CCM are similar but have shown errors. EP, NZ and
other sources are hit or miss. Commits is hand-checked and generally the most recent (so commits comes first for School).
Player-entered input comes first (Height: NDC first). A source's weight is used in the weighted votes; priority lists decide everything else.

## Normalisers (apply to every source before comparing)

- All text fields: ASCII-folded (accents/diacritics stripped, a few letters mapped: ss, o, ae, l; curly quotes to straight). Mojibake
  (A-tilde style garbage) is detected on the RAW value and loses to any clean spelling. No non-ASCII character survives in any field.
- Position: F, D, G, or F/D (D/F becomes F/D). Anything else (including the old master's `0` junk, 62 rows) is blank.
- Height: `5'6"` format only (feet 4-6, inches 0-11). Old master had five formats incl. curly quotes.
- Weight 80-250 lb. GPA 0-5. Grad/BirthYr must be sane years.
- DOB: accepts M/D/YYYY, M-D-YYYY (ProvRosters dash format), M/YYYY, M/0/YY (month only), YYYY (year only); trailing "(...)" stripped;
  #REF! and years outside 1990-2018 rejected.

## Field rules

**Name.** Collect every spelling any source offers (commits, ndc, ccm, prov, nepsac, tourn, ma, colrosters, d3), then score:
reject junk (digits, symbols, mojibake); penalise ALL CAPS / all lower / lowercase words; +4 if the first name matches the personkey's
canonical first name (formal name wins: Lillian over Lily, Catherine over Catie), +2 if the last name matches the key, +0.5 per internal
capital (McLay over Mclay), +0.6 for a real apostrophe (O'Brien), +0.3 per extra agreeing source; ties go to the priority order.
Replaces the sheet's "alphabetically last" rule. Known oddities: `dau|sophia` shows Sophia Dau (colrosters) while NDC says Sophia Johnson (name
change, see PK_EXCEPTIONS.md); `beilenberghowarth|kennedi` and `serdachy|jordan` have misspelled keys; OConnell/OKeefe/MIa have no
better spelling in any source.

**BirthYr.** Priority: override, ndc, ccm, commits, prov, ma, tourn, d3, ep (EP counted only if it fits, see EP rule). If no source
gives one, the year of DOB/DOBPartial is used (source `dob-year`). Never inferred from Grad alone. 57 tourney/EP values differ from the old master
and in sampled cases the candidate fits Grad (graduating age 17-19) where the old master does not. 16 players the old master had a BirthYr for
now have none (their old values came from data the tourneys/rosters cleanup removed; e.g. bergeron|zoe, campbell|grace, daley|taylor).

**EP rule (EP_NOTES.md).** EP rows count only when personkey AND year of birth match: with a known BirthYr only EP rows with that year;
with none known, EP counts only if all its rows for the key agree on one year. EP is gap-filler, last in every list.

**DOB / DOBPartial.** Weighted vote, precision-aware. Full dates go in `DOB`; month-only or year-only go in `DOBPartial` (DOB left blank).
Each source supports a claim once: exact match +weight, consistent at another precision +0.5 weight, contradiction -0.5 weight.
Weights (`dobTrust`): ndc 5, prov 2, ccm 2, commits 1.5, d3 1.5, tourn 1, ep 1. A claim whose year differs from the known BirthYr gets -2.
The winner is refined to the most precise consistent claim. A dead heat between conflicting claims falls back to the shared month or year
and is flagged ambiguous. NDC dates on the 1st of the month in 2025-26 (`dobDay1Suspect`) count as month-only (known recording error).
Per-player overrides beat everything. Totals: 4,763 full DOB, 507 partial only, rest none.

**Grad.** Priority: override, tourn, ndc, prov, nepsac, ma, ccm, commits, d3 (commits' EST. ARRIVAL year is used). Confirmed fine as is.
Candidate has 633 players with a Grad the old master lacked and 106 differences.

**Position.** Weighted vote, `posTrust`: ndc 5, prov 2, ccm 2, commits 1.5, d3 1.5, ma 1, nepsac 1, tourn 1, colrosters 1, ep 0.7. F/D is its
own claim and only wins when a source says F/D (it also gives half weight to F and D); a plain F or D never creates F/D. Ties: newest row
season/year, then priority order. About 100 F-vs-D disagreements with the old master were exported to `Claude outputs/position_conflicts.csv`
for a PM column. Position IS overridable now (overrides.json field `Position`, value F/D/G/F/D); rulings from the PM column become overrides, everything else keeps the weighted vote.

**Height.** ndc, prov, tourn, colrosters, ep (NDC first because players enter it). Weight: ndc, prov, ep. GPA: ndc only.
Most Height/Weight/GPA differences vs the old master are the old master holding last year's NDC value (NDC 2026 rows added since).

**City.** ndc, ccm, commits, prov, nepsac, tourn, colrosters.

**State / Country (standardised after picking).** PM rule (Oct 3): always the official 2-letter province codes. State = USPS code for US states, 2-letter province code (ON BC QC AB MB SK NS NB NL PE NT YT NU)
for Canada (old ONT/BCO/QUE/ALB/NSC/NFL/NBR/MAN/SAS/PEI converted), IOC 3-letter code for anyone else (CZE SWE FIN JPN KOR GER SUI ...).
Country = US | CAN | Intl, derived from State whenever State is a US state or Canadian province; otherwise the source's own Country
(Asia/Europe/Korea/Intl all become Intl). Country source order puts tourn LAST: tourneys' country is the team's country, not home.
Tourn country agrees with the state-derived country 96% of the time (2,984/3,118), so it is an acceptable last fallback. About 75 Country
differences vs the old master are US/CAN swaps where State is blank and tourn is the only evidence. ~6,978 players have a Country but no State.
When Country was derived from State, the sidecar has `src: "state"` and the original in `alts`.
CHECK before relying on site code: the old master used the old province codes; confirm no TopShelf page depends on ONT/BCO etc.

**School.** commits, ndc, nepsac, tourn (commits first: hand-checked, generally most recent). Some NDC values are club teams ("BK Selects"),
that is how NDC reports it. 15 players the old master had `BK Selects` for are blank in the candidate (source of those not found).

**College.** override, commits, d3, legacy, colrosters. `legacy` = the old master.json College, used as a stopgap because (a) 276 D3 college names
in the old master (StMarys, Hamline, Amherst...) are not in commits_d3.json, and (b) it preserves the original COMMIT school for transfers
(colrosters shows the current school). Sidecar marks these as `legacy` so we can find them when real D3 data arrives. College spellings are still
inconsistent across sources (StMarys / Saint Mary's / SUNY Plattsburgh / Plattsburgh): a college-name cleanup is a later job.
`overrides.json` can force College blank (`value: ""`).

**Notable.** commits, then d3.

**Team2024 / Team2025 / Team2026.** From the rosters data (rosters.json + rosters_archive.json), season starting that year. A player can be on 2+
teams in a season (428 player-seasons: guest appearances, showcase vs home team). The team with the LATEST tournament wins, using import_tourneys.js
RECENCY (Pittsburgh < MNRosters < Stoney < NIT < Misc, "later wins any conflict"), then more tournaments, then older age group, then label order.
The old sheet effectively took the alphabetically last team, which is arbitrary. Other teams that season are in the sidecar `alts`.
Label differences vs the old master (632 / 748 / 298) are almost all the roster cleanup (full club names, U18 > U22 / U15 relabels, Shattuck "Prep").
Spot-check: allen|lucy 2026 now Anaheim 16U (was Les Olympiques U18); some 2024 players moved U18 > U15 (adler|hannah, agnello|macy).

**Team (single club label, no level).** commits `Club(clean)` (equals the old Team for 822/827), then NDC `TEAM`, then ProvRosters `Team`, each cleaned to the
Type-table friendly club via `import_tourneys.js` stripTags + typeMatcher (type_aliases.json). NEPSAC is NOT used (it is a school). No tourneys fallback
(Team2024-26 already carry that). Known bug: stripTags treats a number inside a name as an age tag ("Stars 55 Mauricie-CDQ" becomes "Stars").
562 players gain a Team the old master lacked (549 from NDC).

**CCM68.** "Yes" if the personkey is in ccm68.json.

**Regionals.** "Yes" if the personkey is in `regionals.json`, a flat list (427 rows: Name, State, BirthYr, personkey) taken from the first four columns of the sheet's Regionals tab
(those columns already pick from the district tables to their right; the rest of the tab was not imported). Reproduces the old master exactly (363/363 flagged). 64 of the 427 are not in the player
universe (not in commits/ndc/prov/nepsac/tourn/ccm/ma), so they get no Master row and the flag is dropped; several look like reversed keys (melanie|allen, kendall|powers). To re-import, rebuild regionals.json from the sheet.

**Camp columns (tools/campRank.js; replaces PeakCamp/ByYear).** Rank scales: US 1=U15, 2=U1617, 3=U18, 4=WNT; CAN 0=ON_U16, 1=prov camp, 2=prov team, 3=U18-C, 4=WNT-C; Intl WNT-O = 4.
- Fresh / Soph / Jr / Sr = peak camp label in Grad-4, Grad-3, Grad-2, Grad-1 (uses the candidate Grad). `x` when that year is past age 17 (year > BirthYr+17).
- Yr0..Yr3 = camp FLOW string for the years the player is 14..17 (BirthYr+14 .. BirthYr+17), e.g. `ONcamp->TmON-R->U18-C->WNT-C`. Independent of Grad.
  When both a US and a Canadian row exist for the same year, the flow of the higher-ranked one is used.
- Highest = all-time peak label (WNT-O wins for flagged Intl players).
- GradGuessed = "Yes" when Grad is blank but Yr0..Yr3 were still computed from BirthYr.
- WNT-O (international national team): Commits flags only the player (`WNT-O` column), no years. Years = the 4-digit years in NOTABLE
  (e.g. "U18 2024,2025,2026 (3X)"); if none there, the year of the commit announcement (Date Added). `intl_wnt_o.json` holds optional hand-added
  keys (`personkey|year`) and extra players; it is empty by default.
- Verified against the old master: Fresh/Soph/Jr/Sr differ on 2/6/4/7 players, Yr0-Yr3 on 0/0/2/1, Highest on 4. New ON_U16 data adds some Yr1 values.
- Not built: Regionals (deferred by PM).

## Overrides (overrides.json, 27 entries)

Format `{personkey, field, value, notes}`. Overridable fields: `Grad`, `BirthYr`, `Position`, `College` (`""` forces blank), `DOB` (full date), `DOBPartial` (partial,
DOB left blank). Contents: 6 Grad fixes and 2 College blanks from the spreadsheet Overrides tab, 16 PM decisions made Oct 3 on `dob_conflicts.csv`
(notes start "PM 10/3:"), and 3 best guesses (belanger|eva 4/6/2011, logan|reese 3/5/2006, mackinnon|jessica 11/2/2006). gasse|sophianne: PM said
"keep commits" but there is no commits row, so the ProvRosters date was kept. Review CSVs: `Claude outputs/dob_conflicts.csv` (PM column filled),
`dob_review_round2.csv`, `position_conflicts.csv` (PM column still to fill).

## Replication results (candidate vs old master.json, 12,476 players in both)

Field: same / differ / old-master-only / candidate-only. Name 12272/204/0/0; BirthYr 9540/57/16/365; DOB 4148/420/42/155 (about 400 differ because the old master stored
month-only or year-only dates as the 1st of the month, which the candidate fixes); Grad 10504/106/6/633; Position 12086/140/27/70; Height 4598/180/45/297;
Weight 2566/123/24/85; GPA 1052/101/8/1; City 4112/18/0/198; State 3997/1223/0/120 (1,200 are just the code standardisation); Country 12197/96/31/16;
School 2876/44/15/25; Team2024-26 3162/632, 4603/748, 4267/298; Team 1767/120/0/562; College 2075/6/0/13; CCM68 800/0/0/3; Highest 2665/4/13/0.
Differences are expected where the tourneys/rosters cleanup changed data, where NDC 2026 rows replaced stale 2025 values, and where the old master had junk.

## Open items (come back to these)

1. Regionals: 64 of 427 not in the player universe (decide whether to add regionals-only players). 2. (Done Oct 3) candidate promoted to master.json; old file kept as master_last_hockeyfile.json. Watch the site pages that read Team, camp columns and State codes after deploy.
3. `position_conflicts.csv` PM column still empty (Oct 3, no rulings received yet); when filled, convert to Position overrides.
4. College: 276 legacy D3 values need real D3 data (commits_d3 is a stopgap, 2 blank and 18 duplicate personkeys inside it; commits_d3_raw conversion is still manual);
   college-name spelling cleanup.
5. State codes: confirm TopShelf pages do not rely on old Canada codes; Country/State blank for ~6,978 players (only tourn country available).
6. 15 `BK Selects` School values and 16 BirthYr values exist only in the old master; 114 old-master-only players and 89 candidate-only players not yet reviewed;
   decide whether colrosters-only players (~1,300) should join the universe.
7. Team: stripTags number bug; ashlyncook|mary and beigel|teagan (NDC club replaced old values).
8. Name key typos (`beilenberghowarth|kennedi`, `serdachy|jordan`), `dau|sophia` name-change collision.
9. NEPSAC State differs from old master for ~23 players (prep-school state vs home state); check which NEPSAC field to read.
10. Update the `tools/*.md` set / README references when master.json is promoted.

## Files changed or added for this work (commit these)

master.json (promoted), master_sources.json, master_last_hockeyfile.json, tools/build_master.js, tools/master_picks.json, tools/MASTER_NOTES.md, tools/campRank.js (newest copy), tools/import_tourneys.js (flattenPlayers is used by the build),
rosters_archive.json, overrides.json, commits_d3.json, intl_wnt_o.json, regionals.json. Scratch, do not commit: master_candidate.json, master_diff.json.

## Grad rule (Oct 2026) and Master Viewer
- Grad priority is override, ndc, tourn, prov, nepsac, ma, ccm, commits, d3, with one exception in `pickGrad()` (build_master.js): a tournament/roster grad year beats NDC only when its season starts AFTER the newest NDC camp year, it differs from NDC, and Grad - BirthYr is 17..19 (a probable reclass). The overruled NDC value goes in alts and the sidecar note reads "newer than NDC (season X vs NDC Y)". Result on promotion: 33 Grad values changed vs the previous master (plus the camp columns that follow from Grad); 58 players keep a newer-than-NDC tourney grad.
- Generic overrides: overrides.json can override any ORDER field (value '' forces blank) except the specially handled Grad/BirthYr/Position/College/DOB/DOBPartial/PersonKey, which are handled where they are picked.
- Master Viewer: new tab in hockeyfile/updates.html (own script block at the end of the page). Shows master next to every source; green text = master value, solid thin green box = source the picker used, dotted green box = sources that agreed. Overrides column is editable and saves to overrides.json (optionally patching master.json and master_sources.json). Deep link: updates.html?mv=<personkey>.

## Source corrections (Oct 2026)
- Principle: a wrong value is corrected AT ITS SOURCE, not papered over with overrides/merges. Overrides remain for judgment calls on what master should show; they are not for typos. A typo in a name creates a second personkey, so the fix must be in the source data (see TOURNEYS_NOTES: "fix a wrong name in the data, never override a key").
- Master Viewer: double-click a source value (or the pencil that appears on hover) -> "Correct in source" popover (value, corrected value, which rows of that player it will change, note) -> "Queue correction" appends to `source_corrections.json` (sha-checked commit). Single click still copies the value into Overrides. Sources that are re-imported from outside (EP) or derived cannot be corrected here.
- `source_corrections.json` entries: source, personkey, field, from, to, note, added. Meaning: in that source, every row of that player whose field currently equals `from` becomes `to`.
- `node tools/apply_corrections.js [--dry-run] [--rebuild]` applies them: text-level edits for ndc/commits/prov/ccm/nepsac/ma/colrosters json (formatting untouched) and a structured, exact round-trip edit of `rosters.json` and `rosters_archive.json` for the `tourn` source (every season of the player, both files, so a season held by both stays consistent; a Name correction also rebuilds the personkey with makePersonKey + applyPkException and merges into a twin row if the corrected name is already on that roster); `--rebuild` then reruns build_master.js. There is NO re-import step any more: rosters.json is the editable source. Idempotent.
- Oct 2026 change: the tournament CSV pipeline is retired. `archive/tourneys_2023-2026.csv`, `tools/import_tourneys.js` (CLI) and `tourneys_all.json` are history and nothing in the rebuild reads them; the importer's functions are still used by the build and the Teams tab. Verified before the switch: master built from rosters_archive.json + rosters.json was byte-identical to master built the old way.

## Rebuild from the Master Viewer (GitHub Actions)
- Workflow: `tools/rebuild.workflow.yml` is the workflow source; it must be copied to `.github/workflows/rebuild.yml` in the repo (remote tools cannot write the .github folder) and committed once. Inputs: mode = review | promote.
- review: runs `apply_corrections.js --rebuild` + `rebuild_summary.js` on a GitHub runner and force-pushes only `rebuild_summary.json` to the branch `rebuild-review`. main is untouched.
- promote: same run, then copies master_candidate.json over master.json and commits the results (sources, rosters.json, rosters_archive.json, master.json, master_sources.json) to main. Scratch files (master_candidate/master_diff/rebuild_log) are not committed.
- The viewer's "Queued source corrections" card lists the queue, starts the runs through the GitHub API (workflow_dispatch), polls the run, and shows the review summary. Needs a fine-grained token with Contents AND Actions read/write.
- The runner needs every build input committed to the repo (ep.json, master_last_hockeyfile.json, rosters.json, rosters_archive.json, ...); the workflow's first step stops with a clear message if one is missing.

## Pipeline tab (updates.html, Oct 2026)
- The Pipeline tab draws the flow (sources -> master; tourneys -> rosters -> master). Each box shows the file's last commit time from GitHub. Green = committed before master.json was last built (already in master). Red = committed after (master does not have it yet). Any red source, a red extra input (commits_d3, regionals, type_aliases, firstNameMap, intl_wnt_o, master_picks) or a queued correction turns master red.
- "Up to date" means "included in master", judged from commit times. It does not know whether an upstream spreadsheet or website has newer data than the JSON file.
- The tourneys box is intake only (the Teams tab writes rosters.json). The rebuild card (apply queued corrections, review, promote) moved from the Master Viewer to this tab. A review summary older than the current master.json is hidden.
- `source_corrections.json` now has two lists: `corrections` (the queue, only entries still waiting) and `applied` (history). `apply_corrections.js` moves each correction it applied from the queue to `applied`; one with no matching rows stays queued so someone looks at it.
