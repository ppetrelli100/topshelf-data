# ma.json — Massachusetts state camp selection ladder

`ma.json` (851 rows, in `topshelf-data`) tracks Massachusetts players through
the state's 4-year eligibility ladder for national camp selection:

- **14yo**: open Regional tryouts -> ~28 selected for Regional camp
  (`Regional-Tryouts` / `Regional-Selected`)
- **15yo**: Festival (~80) -> Final-40 -> ~25 selected for NDC U15
  (`U15-Festival` / `U15-Final-40` / `U15-NDC`)
- **16yo**: Festival (~80 for that birth year) -> Final-40 (combined with the
  17yo cohort) -> ~15 selected for NDC U16/17, first attempt
  (`U1617-Festival` / `U1617-Final-40` / `U1617-NDC`)
- **17yo**: same funnel, second and final attempt at U16/17 NDC
  (`U1617-2-Festival` / `U1617-2-Final-40` / `U1617-2-NDC`)

A `1` in a stage column means selected/advanced at that level. A `2` means
selected AND made WNT -- not meaningful here since NDC.json already carries
final NDC rosters; treat `2` the same as `1` for MA purposes. A `-` means the
player was age-eligible for that stage but did not advance; a blank means no
data for that stage (usually because the birth year predates when Regional
was tracked, or the player hasn't reached that age yet).

Current through the 2026 selection cycle (Regional/Festival/NDC results for
birth years 2010, 2011, 2012 were folded in from the source spreadsheet's
`26_10`/`26_11`/`26_12` tabs and, for the 2012 cohort specifically, from two
separate 2026 Eastern Select Camp tryout/selection PDFs after the workbook's
own `26_12` tab turned out to be a stale, uncorrected copy of `26_11`'s
roster rather than the true 14yo/2012 cohort).

## Data quality notes

- **Several Last/First swap rows, mostly goalies**: `Savicke, McKenna`,
  `Allen, Melanie`, `Brindle, Kiera`, `Dionne, Cadence`, `Holland, Elise`,
  `Keller, Caitlyn`, `Powers, Kendall`, and `Rizzitello, Olivia` all had their
  LastName/FirstName/Name display columns reversed in the source. Fixed to
  the correct order; personkeys were already built correctly from the true
  name in all eight cases, so no downstream personkey changed.
- **`hansen|?`** (birth 2008, G): first name is a literal `?` placeholder in
  the source data -- genuinely unknown, not yet resolved.
- **`bonavita|madison`**: source nickname "Maddie" was mechanically mapped to
  Madelyn; confirmed by Paulash to be Madison instead. Fixed.
- **`minucci|madelyn`** (birth 2009, G): source nickname "Maddie" mechanically
  mapped to Madelyn. Unlike Bonavita, this is **not independently confirmed**
  -- master.json, commits.json, and ep.json all agree on "Madelyn," but all
  three likely inherited the same mechanical nickname-map default rather than
  an independently sourced full name, so the agreement isn't real
  corroboration. Left as Madelyn for consistency with those other sources
  (so a personkey join across sources doesn't silently break), but flagged
  here as an open item if a real source for her full name ever turns up.
  Her BirthYr was corrected from a stale 2011 to the confirmed-correct 2009.
- **`doherty|caroline`** (two rows, birth 2006 and birth 2008): a genuine
  two-different-real-people personkey collision, not a duplicate -- confirmed
  against EliteProspects, Neutral Zone, and an Instagram commitment post.
  Birth 2006 (Hingham, Williston Northampton, Massachusetts Spitfires U19) is
  committed to Holy Cross, grad 2026. Birth 2008 (Duxbury, Winchendon, grad
  2026) is committed to Amherst College. Both rows are correctly split by
  BirthYr already in ma.json -- match on personkey + BirthYr together here,
  same rule as ep.json. Separately, master.json currently has a single
  contaminated `doherty|caroline` row blending both players' facts (BirthYr
  2006 + College Holy Cross from the Hingham player, but DOB and City from
  the Duxbury player), and commits.json has the Duxbury/2008 player wrongly
  tagged College=Holy Cross instead of Amherst -- both are master.json/
  commits.json fixes to make separately, not something ma.json needed to
  resolve.
- **Eight pre-existing position-split duplicate rows** (same player entered
  twice under two positions, e.g. D and F) were merged into single rows:
  Davies Alexandria, Quatrale Mary, Sullivan Katherine, Wright Charlotte
  (all -> F), Noonan Jamison, Pelletier Jane (both -> D), and Young Piper
  (-> G). Position was set to whichever row reflected the more recent/later
  selection stage; no stage-column conflicts were found between any pair.

## Source priority

As with ep.json: no fixed precedence is assumed between MA and other
sources for a given field. This is input only for now -- nothing on the
TopShelf site consumes it yet, and Master still reads its own MA Sheet tab
independently.
