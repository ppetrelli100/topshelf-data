# Roster cleanup rules — the single source of truth

This document describes what `tools/rosterClean.js` does to a raw, pasted
roster row before it becomes part of `colrosters.json`. It's meant to be
readable on its own, without any other context — including by an AI
assistant asked to clean up a pasted roster screenshot that has never seen
this project before.

**The rule that matters most: `tools/rosterClean.js` is the only place this
logic is allowed to live.** `updates.html`, `collegeview.html`, and anyone
(human or AI) doing this by hand should all load that file and run its
functions, never re-implement the rules from scratch or from memory. If a
rule needs to change, it changes there, once.

## What you need before you start

Three files, fetched fresh (not cached) from GitHub each time, since all
three change over time:

- `https://raw.githubusercontent.com/ppetrelli100/topshelf-data/main/tools/rosterClean.js` — the rules themselves
- `https://raw.githubusercontent.com/ppetrelli100/topshelf-data/main/firstNameMap.json` — nickname aliases, manual key overrides, and school-specific exceptions
- `https://raw.githubusercontent.com/ppetrelli100/topshelf-data/main/d1.json` — the live list of D1 college names, for matching a "committed" cell

And, if you're updating an existing school/season rather than adding a new
one: `colrosters.json`, so you can see what's already there and produce a
diff instead of a blind overwrite.

## The steps, in order, per player row

A raw row usually looks like: No / Name / Yr / Pos / Ht / Shoots / Hometown
(sometimes with Hometown and Previous Team as one combined cell, or a
separate State column). Run each player through, in this order:

1. **Strip audio-link junk from the name.** Some school sites append "Hear
   how to pronounce Jane Doe" straight onto the name cell.
   `stripPronounce(name)`.

2. **Strip trailing status tags.** "AP" / "A.P." (Canadian alternate
   player) and "Injured", with or without parentheses, at the end of a
   name are not part of the name. `stripNameTags(name)` removes them;
   `nameTags(name)` tells you which ones were there — **always surface
   this as a flag on the row**, don't silently drop the information that a
   player was tagged.

3. **Build the personkey.** `makePersonKey(name)` after
   `setNameMaps(firstNameMapJson)` has been called once with the fetched
   `firstNameMap.json`. This:
   - Unaccents the name (é→e, ü→u, œ→oe, …) before building the key —
     the *display* name keeps its accent, only the key doesn't.
   - Splits on the first space: everything before is the first name,
     everything after is the last name.
   - Cuts the first name at a stray `(` if present (handles "Jane(Injured)
     Simeon" shaped pastes).
   - Strips every remaining non a-z character from both halves — this is
     what removes hyphens, apostrophes, periods, digits, accented
     leftovers.
   - Runs the first name through the alias table (nickname → canonical,
     e.g. Maggie → Margaret), then the override table (an exact
     `last|first` remap — this is where the manual name-collision fixes,
     like separating two players who'd otherwise land on the same key,
     live).
   - The result is always exactly `lowercase-letters|lowercase-letters`.
     If it isn't, something upstream (usually mangled accents from a
     copy-paste) needs fixing by hand — don't force a bad key through.

   If you're populating `colrosters.json` (school + season known), also
   call `applyPkException(pk, school)` afterward — this handles the
   school-aware disambiguations in `firstNameMap.json`'s `pkExceptions`
   list (same name, different real person, distinguished by which school
   they're on).

4. **Flag ambiguous nicknames.** `computeAmbigIssue(name, pk, pkManual,
   findHistoricalPksForLastName)` — for a short list of first names that
   could resolve to more than one real name (currently: madi, maddie,
   maddi, maddy), don't guess. Flag it for a human to confirm, along with
   whatever else that last name has resolved to before, if you have that
   history available.

5. **Normalize position.** `normalizePos(pos)` — every spelling a school
   site uses (C, LW, RW, A, Center, Centre, Defenseman, Goaltender, …)
   collapses to just `F`, `D`, or `G`. `colrosters.json` never stores
   anything else.

6. **Normalize class year.** `normalizeYear(year)` — Fr/So/Jr/Sr/5th/Gr,
   from any spelling (Freshman, 1st, FY, Soph, Grad, …), with redshirt
   prefixes (R-Fr, R-So, …) preserved.

7. **Normalize height.** `normHeight(raw)` — accepts `5'8"`, `5' 8`,
   `5-8`, `5 ft 8 in`, with curly or straight quotes, and returns
   `{value, issue}` in `F-I` format. A typo like `5'19"` (inches over 11)
   comes back with `value: ''` and a message in `issue` — **never store an
   invalid height, surface it as a flag instead.**

8. **Parse hometown into home / state / country.** Two shapes, depending
   on the source:
   - Combined "Town, ST / Previous Team" cell → `parseHometown(raw)`.
   - Separate Hometown and State/Province cells → `normalizeStateAndHometown(rawState, rawHometown)`,
     which also handles "Canada"/"CAN" ending up in the wrong cell.

   Both match against US states (full names and AP abbreviations like
   "Mass.", "Calif.", "N.Y.") and Canadian provinces (full names,
   abbreviations, and odd spellings like "pq", "nfld"), landing on the
   two-letter code either way. Anything unrecognized comes back tagged
   `__UNKNOWN__` (from `parseHometown`) rather than silently miscategorized
   — **flag it, don't guess.**

9. **Normalize committed school.** `normCommitted(raw, D1json)` — matches
   against the live D1 list: exact match, then case-insensitive, then with
   "University"/"College" stripped from both sides (so "U Conn" and
   "Rensselaer" land on "UCONN" and "RPI"). If nothing matches, the raw
   text is kept as-is with `matched: false` — don't force it onto the
   wrong school.

10. **Clean stray cell junk.** `cleanCell(raw)` on every text cell — turns
    literal "null", "N/A", "None", "-", "—", and extra whitespace into a
    blank.

## What "flag it" means in practice

Several steps above say to flag rather than resolve automatically:
name tags, ambiguous nicknames, bad heights, and unrecognized states. In
`updates.html` this shows up as a warning string attached to the parsed
row, shown in the review table before anything is saved. If you're doing
this by hand (or as an AI reading a screenshot), the equivalent is: don't
silently pick an answer — call it out in your output and let a person
confirm it, the same way the tool would.

## Applying this to a pasted roster screenshot (for an AI assistant)

1. Fetch the three files listed above.
2. Transcribe the screenshot into rows: No, Name, Year/Class, Position,
   Height, Shoots, Hometown (and State/Previous Team if they're separate
   columns). Match column headers loosely — schools label these
   differently (Yr vs Cl vs Class, Ht vs Height, etc.) — same intent as
   `updates.html`'s own header-pattern matching.
3. Run each row through steps 1–10 above, in order, using the actual
   `rosterClean.js` functions (via Node — this file works standalone
   under `require()`, see the comment at its top). Do not hand-simulate
   the personkey logic in your head; run the real code.
4. Produce the output in the same shape `colrosters.json` uses for a
   school/season entry: `{name, pk, y, pos, ht, home, st, ctry, no,
   prevSchool}` (school-level fields; team-roster paste, i.e.
   `rosters.json`, uses `{pk, n, name, ry, rg, rp}` instead — check which
   file you're populating).
5. List every flag from step 4 above separately, don't bury them in the
   data.
6. Hand back a diff against the existing school/season entry in
   `colrosters.json` if one exists, not a blind replacement — the person
   reviewing needs to see what actually changed.

## Keeping this in sync

If you fix an edge case (a new tag to strip, a new state abbreviation, a
new override), change it in `tools/rosterClean.js` only. Every surface —
`updates.html`, `collegeview.html`, and this document's own instructions —
fetches that file fresh each time, so there's nothing else to update
except this document itself, if the *steps* (not the rules) change.
