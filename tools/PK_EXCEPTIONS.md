# pkExceptions — personkey collision log

`firstNameMap.json`'s `pkExceptions` array resolves cases where two different
real players compute to the same `lastname|firstname` personkey, by routing
one of them to a disambiguated key based on school/state/hometown context
(see `rosterClean.js`'s `applyPkException`). The JSON itself only carries the
match rule, not the story behind it -- this file is the "who's who" for each
one, so the context isn't lost if it needs revisiting.

| Base personkey | Match | Resolved to | Notes |
|---|---|---|---|
| `king\|olivia` | School: Maine | `king\|oliviame` | Context not re-documented yet -- predates this migration pass. |
| `jones\|gabriella` | School: New Hampshire | `jones\|gabriellanh` | Context not re-documented yet -- predates this migration pass. |
| `kaiser\|madison` | School: Bemidji State | `kaiser\|madisonbsu` | Context not re-documented yet -- predates this migration pass. |
| `martin\|madeline` | School: Saint Michael's | `martin\|madelyn` | Likely a nickname correction rather than a true two-person collision -- worth confirming. |
| `johnson\|sophia` | State: AK | `dau\|sophia` | Looked like a name change (marriage/legal name change), not a collision between two different people -- resolved by using her new name (Dau) going forward. |
| `louis\|reagan` | State: CA | `louis\|reaganca` | Found during the ccm68 migration (Sept 2026) -- two different real players named Reagan Louis, one IL one CA. |
| `doherty\|caroline` | Hometown: Duxbury | `doherty\|carolinedux` | Found during the MA migration (Sept 2026) -- two different real players named Caroline Doherty: 2006/Hingham, Williston Northampton, committed Holy Cross (stays as base `doherty\|caroline`); 2008/Duxbury, Winchendon, committed Amherst (routed to `doherty\|carolinedux`). Full detail in `tools/MA_NOTES.md`. |
| `doherty\|caroline` | School: The Winchendon School Prep | `doherty\|carolinedux` | Added with the tourneys migration (Oct 2026): same player as the Duxbury entry above (2008, Winchendon, committed Amherst); the tourney data has no hometown, so this matches on the team name instead. The Hingham/Spitfires player (2006, Holy Cross) stays `doherty\|caroline`. |

Add a row here whenever a new `pkExceptions` entry is added, even a brief
one -- better a placeholder note to fill in later than losing the context
entirely.
