# hub_extras — adding TPE games on top of the Hub export

The friend's Hub export is the base. Games pulled from the TPE portal yourself go here as **batches** and are appended every time the hub is rebuilt.
When a later export contains the same game, the export wins automatically (matched on the TPE game id) and the extra is ignored, so nothing is ever double counted.

## Files
- `batch_<date>_<name>.json` — active batches (`{batch, source, games:[{tpe_id, gid, game_date, season, tracked_team, opponent, scores, competition_label, ..., rows:[player-game rows]}]}`)
- `spec_<date>_<name>.json` — the recipe that made a batch (games, team ids, aliases); re-run `tools/make_extra_batch.py` to regenerate it from the captures
- `absorbed/` — batches (or games) the export now has, moved here by `prune` (kept so they can still be compared)
- `hub/hub_extra_xref.json` (build output) — every extra, `active` (in the hub now) or `absorbed` (export has it)

## Workflow
1. **Add games**: capture from the portal (`tpe_game_<id>.json`), write a spec, `python3 tools/make_extra_batch.py SPEC CAPTURE_DIR hub_extras/batch_<date>_<name>.json` (checks goals vs the score), rebuild: `python3 tools/build_hub_json.py`.
2. **New export arrives** (point `build_hub_json.py` at it, first arg):
   - `python3 tools/hub_extras.py status  [EXPORT_DIR]` — which extras the export now has
   - `python3 tools/hub_extras.py compare [EXPORT_DIR]` — checks my portal capture against the export's rows for those games (per-team totals of 12 columns + player count): a free validation of the capture rules
   - `python3 tools/hub_extras.py prune   [EXPORT_DIR]` — moves them to `absorbed/`
   - `python3 tools/build_hub_json.py` — rebuild (this is also what actually drops the extras, `prune` just tidies the folder)
3. Nothing in `hub_games.json` marks an extra (schema unchanged); use `hub/hub_extra_xref.json`.

## Conventions used for portal games (change in the spec `defaults`/`alias` if needed)
tracked_team = home team, is_opponent = 1 for the away side, result REGULATION, age_bracket 'Unlabeled' (high school), event_type 'League / season', league_family 'Prep / high school', country 'Unknown', tracked_in_topshelf 'N', competition_label = the portal season name. Players join the hub by name (firstNameMap overrides apply); positions come from master.json when the player is in it.

## Hudl games captured by hand (`hudl_<date>_<name>.txt` + `.json`)
Same idea as the TPE batches, for Hudl Instat games the export does not hold yet. Read by `tools/hudl_extras.py`, appended by `tools/build_hub_hudl.py` on every run.
- `.txt` = one block per Hudl match: `#<match id>`, `T0|<team>` / `T1|<team>` skater rows, `G0` / `G1` goalie rows (pipe separated, `jersey~name` first; column order in the `.json` `skater_fields` / `goalie_fields`). Captured from the match page's **Skaters** and **Goalies** tabs (Hudl hides the full 133-column table behind that tab; we keep the same ~35 fields the export carries: TOI, shifts, PP/SH time, shots, plus/minus, faceoffs by zone, Corsi/Fenwick, xG, goals/points, penalties).
- `.json` = per match: date, competition, home/away, score.
- A match is skipped once the export holds it (matched on `game.source_record_id` = the number in `/matches/<id>`), so nothing double counts when a newer export arrives.
- Team names: the Hudl-side name is kept (same Hudl team in other games, else the name as captured). A game both platforms hold (date +-1 day, 5+ shared players on a TPE game) shares that game's identity, so TPE+Hudl never double count.
- Hudl matches with unnamed players ("Hudl player ####" / "noname noname") are dropped by the placeholder filter, as for the export.
- 2026-11-21: 9 Lovell Academy 16U AAA games (2233016, 2276925, 2278259, 2283754, 2285451, 2285489, 2285496, 2286088, 2286110).
- 2026-11-21: 2 East Coast Wizards 16U AAA games (2285469, 2288877).

## TPE batches captured 2026-11-21 (`spec_/batch_2026-11-21_*.json`, 57 games)
Chicago Mission, Shattuck St. Marys, Philadelphia Jr. Flyers, Little Caesars, Team North Dakota, Fox Motors U16 T1 W (4 games) and Fox Motors U16 (team 4875, 28 games), each with its opponents' sides from the same game feed. Known gaps: Little Caesars 174007 (OT/shootout, portal goals 2-2 vs final 2-3); Fox 173145 (opponent Honeybaked has no TPE roster, 1 goal missing from rows); Fox Motors U16 (4875) competition_label is generic except 174406 (T1EHL U16 26/27); Fox (4875) is a separate squad from the hub's Fox Motors U16 W, and opponent names are the portal names (not aliased to hub " W" names).

## TPE batches captured 2026-11-21, 19U/U22/14U pass (`spec_/batch_2026-11-21_*.json`, 90 games)
Teams with >=15 TPE games on the TopShelf lists: 19U (Shattuck St. Marys x2 pages, Chicago Mission, Little Caesars, Philadelphia Jr. Flyers T1, Winchendon), U22 (Etobicoke, Burlington), Stanstead College, 14U (Chicago Mission, Little Caesars, Philadelphia Jr. Flyers T1, Ohio Blue Jackets), each with opponents' sides. Opponent/own names aliased to hub names where the hub already had the team. Competition labels are generic ("Competition not recorded 26/27"). 24 placeholder 0-0 games skipped (no data). Known gaps: goals check mismatches on Little Caesars U19 176528 (3-2) and 174484 (1-2), Etobicoke 166650 (2-5) - portal rows missing goals (likely OT/shootout or untracked opponent). MN 14U teams were already complete in the hub. Teams 5195, 5571 not captured.

## Hudl top-25 16U pass 2026-11-21 (`hudl_2026-11-21_16u-top25.txt/.json`, 58 games)
Top-25 teams of the 2026-27 MHR 16U ranking (Hudl team pages for Chicago Mission, CT Polar Bears, Bishop Kearney, Boston Jr. Eagles, Philadelphia Jr. Flyers, Little Caesars, Valley Jr. Warriors, MN Elite (Sky/Silver/Gold/White/Streamline), Team Illinois, Team North Dakota, Fox Motors, Dallas Stars Elite, Boston Americans, Mid Fairfield, Pittsburgh Penguins Elite, Team Wisconsin, Winchendon) - every 2026-27 match (from 2026-08-01) the 2026-10-31 export and the earlier Wizards/Lovell batches do not hold, both sides. Captured from each match's Skaters and Goalies XLS exports with all 131 columns switched on in Hudl's table settings (the account setting now persists); skater goals per team equal the final score in all 58 games. Not on Hudl (no team page found): Shattuck St. Mary's, NAHA Winter Hawks; MHR #2 has no hub team. 29 of the 69 Hudl extras pair with a TPE game (TPE wins, never summed). Team names are the Hudl names; the builder maps them to hub names, and a few mappings look off (MN Elite Streamline, MN Elite 16U, Philadelphia 16U Orange, Seattle Red Hawks) and need a manual check.

## Hudl top-25 19U and 14U pass 2026-11-22 (`hudl_2026-11-22_1914-top25.txt/.json`, 157 games)
Same method as the 16U pass for the top-25 teams of the 2026-27 MHR USA 19U and USA 14U rankings (Hudl team pages for Chicago Mission, Lovell, Little Caesars, Team Illinois, Valley, Boston Jr. Eagles, CT Polar Bears, East Coast Wizards, Bishop Kearney, Pittsburgh, Boston Americans, Philadelphia Jr. Flyers, Belle Tire, Mid Fairfield, Assabet, Winchendon, NE Wildcats, MN Walleye/Green Giants/Loons/Lakers, NY Dynamo, Charles River, Windy City, Wisconsin, NJ Colonials, LA Lions, Madison, Milwaukee) - 158 matches listed from 2026-08-01 that the hub did not hold, both sides, from each match's Skaters and Goalies XLS exports (all 133 columns). Skater goals equal the final score in 156 of 157 games (2251336: Thunder Bay Queens U15 AA scored 2 per Hudl's score but only 1 skater goal is credited). Whitby Junior Wolves has no goalie data in 2251276. 2286921 is left out: a second Hudl tracking of the same game as 2286589 (Milwaukee Jr. Admirals 14U v East Coast Wizards 14U, 2026-11-08). Competition names were not captured (`competition` is empty). No Hudl team page found for: Shattuck St. Mary's 19U, NAHA, Culver, Gilmour, Masters Academy 19U, Buffalo Jr. Sabres 14U (partial), MN Moose 14U, MN Elite Vegas/Green/Navy 19U (only as opponents); only opponents' games against the top-25 teams are here, not their other games.
Team names: the shared-player match in `build_hub_hudl.py` mis-filed a few sides; `hub_game_exclusions.json` `hudl_extras_team` ({hudl_id, team, as}) pins the right hub name per match (6 entries). Mappings still worth a manual look: Barrie Jr. Sharks (-> Barrie Sharks U15 AA W), Bluewater Jr. Hawks (-> London Devilettes U15 AA), Whitby Junior Wolves (-> Durham West Lightning U18 AA), Connecticut Polar Bears 19U Minor 1 (-> 19U Prep), Master's Academy International 19U.
