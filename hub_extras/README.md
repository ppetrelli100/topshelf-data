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
