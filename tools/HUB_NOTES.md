# Hub (TPE game data): how it works and every rule we settled (Nov 2026)

The Hub is a friend's hockey-stats site (Lovable app on Supabase/Postgres) built on TPE game tracking. He exports it as CSVs;
`tools/build_hub_json.py` turns that export into the static JSON in `hub/`; `hockeyfile/hubcard.js` (the TPE card on
`playerview.html`) reads it. This file records HOW each step works and WHY. Read it before changing the build or the card.

Status (Nov 2, 2026): first export is "Hub Export 2026-10-31" (4 seasons, 2023-24 to 2026-27). Build and card are done and tested
in a stand-alone harness; see "Open items" for what is not yet live.

## 1. The export (input)
- Folder: `dev\Hub Export 2026-10-31\` (outside the repo). 14 CSVs plus `README.txt` and `schema.md` from the friend. UTF-8, header row, empty = NULL.
- 22,745 games = 14,783 Hudl (thin) + 7,962 TPE (deep). 7,661 TPE games have player stats; 260,612 TPE player-game rows have time on ice > 0.
- **TPE and Hudl are never added together.** `game.source_system` says which a game is; `hudl_game_pair` links 1,386 games that exist in both. The build uses TPE only.
- Not in the export (versus the bbngvh per-game files): shifts, power-play/penalty-kill unit lines, maps, period scores.
- `player.csv` has no date of birth. One real person can have several player rows (35,308 TPE player rows are about 17,900 people), which is why everything is keyed by personkey.
- Superseded games (`superseded_by_game_id` set) are excluded.
- A refresh needs a new export from the friend, then a rebuild (section 2).
- `dev\Hub Export 2026-10-31\game_universe.csv/.xlsx` is a one-off table of all 22,745 games with age bracket, league family, event type, country guess and depth tier. The build reads `game_universe.csv` for the game tags in `hub_games.json`. Regenerate it for a new export before rebuilding (the script that made it is not in the repo).

## 2. Rebuilding
- Run: `python3 tools/build_hub_json.py [EXPORT_DIR] [TOPSHELF_DATA_DIR] [OUT_DIR]`. Defaults: the export folder above, this repo, `hub/`.
- Needs python3 with pandas and numpy, plus node (the script calls `tools/rosterClean.js` so personkeys come from the real `makePersonKey`). About 2 minutes, about 2 GB of memory.
- Reads: export CSVs, `master.json`, `firstNameMap.json`, `mhr_current.json`, `mhr_history.json`, `hub/hub_team_aliases.json`, `game_universe.csv`.
- Writes to `hub/`: the JSON files in section 3 plus three review CSVs (`placeholders_dropped.csv`, `hub_teams_without_mhr.csv`, `mhr_top25_without_hub_team.csv`).
- After a rebuild: commit and push `hub/`; the card reads from GitHub raw.
- Do not commit a leftover `hub/_pk_in.json` (from an old failed run; the script now keeps its temp file outside the repo).

## 3. Output files (`hub/`)
All are `{header, rows}` (plus nothing else except `hub_meta.json`). Rows reference dimensions by index so files stay small. Each file is under the 25 MiB Pages limit (largest about 14 MiB).

| File | One row per | Key columns |
|---|---|---|
| `hub_meta.json` | (single object) | `seasons` (list, en-dash labels like `2025–26`), `teams` (list of team names), `built`, `source`, `notes` |
| `hub_players.json` | person (personkey) | `pk, name, inMaster, pos, gp, seasons` (`seasons` = indexes into `meta.seasons`). `name` is the master name when matched, else the Hub name |
| `hub_games.json` | TPE game with stats | `gid, game_date, season (index), tracked_team (name), opponent (name), score_for, score_against, result, overtime, age_bracket, event_type, league_family, country_guess, competition_label, tracked_in_topshelf` |
| `hub_player_seasons.json` | player x season x team | `pi, si, ti, pos, gp` then summed stats, then `avg_possession_seconds_mean` |
| `hub_pgs_<season>.json` (4 files) | player x game | `gi, pi, ti, pos, opp` then the same summed-stat columns (per game) then `avg_possession_seconds`. For drill-down; the card does not load these |
| `hub_team_rank.json` | team x season matched to MHR | `ti, si, level, rank, mhr_name` |
| `hub_team_aliases.json` | (hand-edited) | `{"Hub team name": "exact MHR team name"}` |

Index columns: `pi` = row index in `hub_players.json`, `si` = index in `meta.seasons`, `ti` = index in `meta.teams`, `gi` = row index in `hub_games.json`. Reorder any of those lists and every index breaks, so always rebuild all files together.

Stat columns (sums over games, nulls count as 0): `toi_seconds, shifts, goals, assists, primary_assists, secondary_assists, shots_on_goal, shot_attempts, blocked_shots, scoring_chances, danger_shot_attempts, plus_minus, passes_successful, passes_unsuccessful, key_passes, total_possession_seconds, oz/nz/dz_possession_seconds, true_total_possessions, recoveries, giveaways`, the eight `tpe_entries_*` / `tpe_exits_*` columns (successful/failed x controlled/uncontrolled), `on_ice_goals_for/against, on_ice_xg_for/against, danger_shots_on_goal, entries_carry_in, exits_carry_out, on_ice_shots_for/against, passes_successful_dz/unsuccessful_dz`, and from the detail table `takeaways, xg, xa, faceoffs_won/lost, pp_toi_seconds, pk_toi_seconds, saves, shots_against, goals_against`. Ratios (pass accuracy and so on) are not stored; compute them from sums.

## 4. Build rules
- TPE games only; rows with `toi_seconds` of 0 or empty are dropped.
- Position comes from `game_roster_entry.position` (F/D/G); a player's position for a season is the most common one.
- Team name = `team_identity.name` through `team.identity_id`, falling back to `team.name`. Opponent rows with no team id take the opponent name from the game universe.
- **Placeholders are dropped.** Some "players" are really a team plus jersey number (for example "Waterloo Ravens U22 Aa W 3"). A row is a placeholder when the name has a digit, an age tag (U16, 16U) or a team word (Academy, School, Elite, Hockey, Club, Prep, Jr, Junior, Team, Rebels, Hawks, Bay, Fury, Impact). First build: 1,450 rows, 915 names, listed in `placeholders_dropped.csv`. Check that list when the regex changes; a real surname containing those words would be dropped.
- If one person appears twice in one game for one team, the rows are summed (20 rows in the first build).
- Sanity check: totals of goals, assists, shots, passes and time on ice in `hub_player_seasons.json` are 0.6 to 0.9% below the raw TPE CSV totals. The gap is the placeholders.
- Season labels: the Hub uses an en-dash (`2025–26`), the MHR files use a hyphen (`2025-26`). Convert before comparing; forgetting this made every MHR match fail once.

## 5. Names and personkeys
- `master.json` is the source of truth for names, spelling, positions, birth year, grad, commit and team names. The Hub is matched TO master, not the reverse.
- Hub personkey = `makePersonKey(first + " " + last)` using the live `firstNameMap.json`. A match means the key equals a master `PersonKey`.
- Overrides in `firstNameMap.json` apply to every source and are keyed on the post-alias key. An override is applied once (no chains). When adding overrides, check no `from` is already a `to` of another override.
- Two directions were used: Master-direction (`hub_key -> master_key`, master spelling wins) and Hub-direction (`master_key -> hub_key`, the fuller Hub name becomes canonical, for example `rossi|lillian -> rossi|liliana`). After any Hub-direction override, `master.json` must be rebuilt, or that player's master key no longer matches and the card will not show.
- Process used: I produced a review workbook (approve column, confidence, notes, ready-made override JSON), you filled it in, and the approved rows were appended to `overrides` as text (the file mixes formatting; do not re-serialize it). Backups: `dev\temp\firstNameMap.backup*_2026-11-02.json`. Totals after: 679 overrides.
- Match rate after the first batch (458 Y rows): 56.7% of Hub people and 78.9% of player-games match master. About 7,000 Hub people are not in master (mostly Canadian and non-tracked clubs); they are kept out of master and shown with their Hub name and `inMaster: 0`.
- Known loose ends: duplicate overrides for `dougherty|cate` and `zhang|luoyi`; a two-way swap `yuan|emily` / `yuan|jiawei`; 60 reviewed pairs deliberately left unmatched (different people or too uncertain).

## 6. MHR rank matching (for the "top 10 / top 25 teams" comparators)
- Source: `mhr_history.json` (finished seasons) and `mhr_current.json` (2026-27, as of its `asof` date). Levels: USA 16U, USA 19U, Canada U18, Canada U22 (plus USA 14U and Canada U15 for 2026-27 only).
- Each Hub team gets a level from its name: U16/16U -> USA 16U, U19/19U -> USA 19U, U18 -> Canada U18, U22 -> Canada U22, U14 -> USA 14U, U15 -> Canada U15. Teams with no age tag (for example "(Prep) W") get a level only via an alias.
- Matching: both names are normalized (lowercase; drop the trailing `(MN)` state code, `(#1)`, tier words, age tags, punctuation and stop words like elite, prep, academy, school, hockey, w, aa, t1), then compared as word sets. A match needs an exact set, or one set contained in the other with similarity at least 0.5, or similarity at least 0.75. Ties between different MHR teams are left unmatched.
- Fixes are hand-entered in `hub/hub_team_aliases.json`, Hub name to the exact MHR name; the next rebuild uses them. Review CSVs show what is missing: `mhr_top25_without_hub_team.csv` (top-25 MHR teams with no Hub team) and `hub_teams_without_mhr.csv`.
- Known misses/wrong matches (Nov 2): USA 16U #2 Minnesota Elite (Blue) and #20 Boston Americans unmatched; #10 Minnesota Elite (White) and #12 Minnesota Elite (Gold) wrongly matched to "Minnesota (MNHP) White Tails" and "Minnesota Northern Elite (Gold)"; Philadelphia Jr. Flyers appears under two Hub names. Canada U18: Battleford Sharks, St. Albert Slash, Ancaster, Sudbury, Greenfoot unmatched; Canada U22: several prep and Quebec teams unmatched.
- Coverage (2026-27, teams with 5+ TPE games in the MHR top 25): USA 16U 15 teams, Canada U18 6, Canada U22 5. Canadian top-N comparisons are thin until more aliases are added.

## 7. The TPE card (`hockeyfile/hubcard.js`, `hubcard.css`, wired into `playerview.html`)
- Data location: one constant, `HUB_BASE` in `playerview.html` (currently the `hub/` folder of `ppetrelli100/topshelf-data` on raw.githubusercontent.com). The repo is public, so these files are public.
- Loads lazily on first player: `hub_meta`, `hub_players`, `hub_player_seasons`, `hub_team_rank` (about 6 MB). Does not load the per-game files.
- Shows for a player (matched by master `PersonKey` = Hub personkey) with 5 or more games for one team in a season (`MIN_GP = 5`; same minimum for everyone in a comparison pool). If none, no card.
- Placed below the player card inside a collapsible section, collapsed for each new player (stays open when you navigate from the card's own list). A season/team picker appears when the player has several.
- Comparators (same position, same season): Teammates (same team); Top 10 teams; Top 25 teams (MHR rank at the player's age level). If the player's team is not in the chosen top N, the player is added to the pool and the card says so.
- Views: Metrics (a bar per metric, ends = lowest and highest value in the pool, badge colored green/amber/red by position between them) and Composite (z-scores by category, weights sliders, index centred on 50 with about 15 points per standard deviation, tiers 1 to 4 at percentile cuts 0.92 / 0.61 / 0.31). Grad-year filter uses master `Grad`. A sortable full list sits below. Goalies show a "skater metrics only" message.
- Categories and default weights: Forwards: Shot generation 30, Puck possession & security 20, Zone entries 15, Defensive metrics 30, Passing 5. Defense: Puck possession, security & exits 40, Offense suppression 25, Offensive metrics 30, Passing 5. Same as `tpe.html`.
- CSS: `hubcard.css` is `tpe.html`'s stylesheet with every selector scoped under `#hubCard`, so it cannot affect the rest of `playerview.html`.

Metric definitions (all per player-season sums; "/20" = per 20 minutes of ice time):
| Metric | Definition | Better |
|---|---|---|
| Possession time / game | `total_possession_seconds / gp` | higher |
| Number of possessions /20 | `true_total_possessions` | higher |
| Giveaways % | `giveaways / true_total_possessions x 100` (matches TPE camp data) | lower |
| Carry out exits /20 | `exits_carry_out` | higher |
| Controlled exit % | `(successful + failed controlled exits) / all four exit counts x 100` (calibrated against the camp data) | higher |
| Shot attempts /20 | `shot_attempts` | higher |
| SOG danger zone /20 | `danger_shots_on_goal` | higher |
| Scoring chances /20 | `scoring_chances` | higher |
| xG /20 | `xg` | higher |
| Carry in entries /20 | `entries_carry_in` | higher |
| Controlled entries /20 | `tpe_entries_successful_controlled` | higher |
| OZ possession (s) /20 | `oz_possession_seconds` | higher |
| On-ice shots against /20 | `on_ice_shots_against` (footnote: reflects linemates, not the player alone) | lower |
| On-ice xG against /20 | `on_ice_xg_against` | lower |
| On-ice xG share | `xg_for / (xg_for + xg_against) x 100` | higher |
| Passing accuracy | `successful / (successful + unsuccessful) x 100` (DZ version uses the dz columns) | higher |

## 8. Gotchas
- Writes to your computer through the assistant tools have landed stale or truncated several times (Google Drive sync). Always verify content after writing (grep or file size), or write to a new filename, check, then rename.
- Files the assistant writes on your computer cannot be copied back to it for testing ("hardlinked" refusal); copy the file out through the chat or test from a clean copy.
- Never commit scratch files (`_pk_in.json`) or the review CSVs unless you want them in the repo.
- `master.json` PersonKeys must be rebuilt after name-override changes, or the Hub join breaks for the affected players.

## 9. Open items
1. Push `topshelf-data` (new `hub/` files, aliases, `tools/build_hub_json.py`, this file), then deploy `hockeyfile` and test the card in the real PlayerView (it was only tested in a stand-alone page).
2. Add MHR aliases for the misses in section 6.
3. Re-measure the Hub-to-master match rate after a master rebuild.
4. Next pages: pivots and charts over `hub_player_seasons.json` (reuse the College Custom pivot UI and the metric definitions above); more comparators on the card.
5. Decide the refresh cadence with the friend (each refresh = new export + rebuild + push).
