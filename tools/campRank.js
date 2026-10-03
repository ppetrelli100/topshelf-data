/* =========================================================================
   campRank.js -- HockeyFile / TopShelf: the ONE canonical set of rules for
   turning a player's raw camp/team/selection rows (ndc.json rows, or
   provrosters.json rows, or a known Intl/WNT-O key) into a rank, a label,
   and a display "flow" string for a given player-year -- and for rolling
   those player-year peaks up into a player's single all-time best.

   This is the JS equivalent of the sheet's PeakCamp tab (A/B/E columns for
   the per-player-year peak, G/H/I for the per-player all-time peak), and
   it replaces three independent, slightly-different hand-rolled copies of
   this same logic that had accumulated in commits.html, camps.html, and
   playerview.html. Do NOT re-implement this logic inline anywhere else --
   see tools/CAMP_DATA.md for why that drift is exactly the failure mode
   this file exists to prevent (same reasoning as tools/rosterClean.js for
   personkeys).

   Rank scales (fixed, match the sheet's PeakCamp/LEVEL_RANK conventions --
   do not renumber without updating PeakCamp's own formulas to match):
     US (NDC):        1=U15   2=U1617   3=U18   4=WNT
     CAN (ProvRosters): 0=ON_U16  1=Prov Camp  2=Prov Team  3=U18 Natl Camp  4=WNT
     Intl (WNT-O, from Commits -- players with no NDC/ProvRosters row at
     all): fixed rank 4, label "WNT-O".

   Works both as a browser <script> (attaches to window.CampRank) and under
   Node (module.exports), same convention as rosterClean.js.
   ========================================================================= */
(function (root, factory) {
  const CampRank = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = CampRank;
  if (typeof window !== 'undefined') window.CampRank = CampRank;
})(this, function () {
  'use strict';

  function truthy1(v) { return /^(1|true)$/i.test(String(v || '').trim()); }
  // A Prov Team-shaped field is "has a team" only when non-blank AND not a
  // literal "0" -- "0" means "tried out, didn't make it", not "no team
  // level exists". This exact confusion was a real, previously-fixed bug
  // in camps.html/commits.html -- see CAMP_DATA.md.
  function hasTeamValue(v) { const t = String(v || '').trim(); return !!t && t !== '0'; }

  /* =======================================================================
     US (NDC) -- one row per camp tier per player-year; a player can have
     more than one row in the same year (e.g. a U1617 row AND a U18 row),
     which is why rankers here operate on a GROUP of rows, not a single row.
     ======================================================================= */

  // Rank/label for a single NDC row, from CAMP + the WNT flag. Returns null
  // for an unrecognized/blank CAMP value rather than guessing.
  function rankNDCRow(row) {
    const camp = String(row.CAMP || '').trim();
    if (camp === 'U18') return truthy1(row.WNT) ? { rank: 4, label: 'WNT' } : { rank: 3, label: 'U18' };
    if (camp === 'U1617') return { rank: 2, label: 'U1617' };
    if (camp === 'U15') return { rank: 1, label: 'U15' };
    return null;
  }

  // The token(s) a single NDC row contributes to a display flow -- a U18
  // row with WNT=1 contributes BOTH "U18" and "WNT" (it's one row
  // representing having passed through U18 on the way to WNT), everything
  // else contributes just its own tier.
  function tokensForNDCRow(row) {
    const camp = String(row.CAMP || '').trim();
    if (camp === 'U18') return truthy1(row.WNT) ? ['U18', 'WNT'] : ['U18'];
    if (camp === 'U1617') return ['U1617'];
    if (camp === 'U15') return ['U15'];
    return [];
  }

  // Peak across ALL of a player's NDC rows for one year (handles the U1617
  // + U18(+WNT) same-year case) -- the direct equivalent of PeakCamp's
  // group-by-key max(rank) step, applied within just the NDC branch.
  function usPeakForYear(rowsForYear) {
    let best = null;
    (rowsForYear || []).forEach(r => {
      const ranked = rankNDCRow(r);
      if (ranked && (!best || ranked.rank > best.rank)) best = ranked;
    });
    return best; // {rank, label} or null
  }

  // Full flow string for one player-year, e.g. "U1617→U18→WNT" -- rows
  // sorted by rank ascending first (source data isn't guaranteed sorted),
  // each contributing its own token(s), never duplicating a tier that
  // appears in more than one row's token list.
  function usFlowForYear(rowsForYear) {
    const sorted = (rowsForYear || []).slice().sort((a, b) => {
      const ra = rankNDCRow(a), rb = rankNDCRow(b);
      return (ra ? ra.rank : -1) - (rb ? rb.rank : -1);
    });
    const seen = new Set();
    const tokens = [];
    sorted.forEach(r => tokensForNDCRow(r).forEach(t => { if (!seen.has(t)) { seen.add(t); tokens.push(t); } }));
    return tokens.join('→'); // "→"
  }

  /* =======================================================================
     CAN (ProvRosters) -- normally one row per player-year, but a real
     multi-province-same-year case exists (a billet situation, e.g. Hayley
     McDonald) -- see CAMP_DATA.md. Rankers here also operate on a GROUP of
     rows for the same reason as the US side, even though the group is
     usually length 1.

     Label convention (confirmed against master.json's existing, pre-Yr0-3
     Fresh/Soph/Jr/Sr fields, which already carry these exact strings --
     this is the established real convention, not a generic placeholder):
       Camp level:  <2-letter province code>+"camp", e.g. "ABcamp", "ONcamp",
                    "ATcamp" (Atlantic uses "AT", 2 letters, for the camp
                    label specifically -- see PROV_CAMP_CODE below).
       Team level:  "Tm"+<code>, e.g. "TmAB", "TmQC" -- with two exceptions:
                    Ontario splits into "TmON-R" (Red) / "TmON-B" (Blue),
                    and the Maritimes lump into one team, "TmAtl" (3 letters
                    -- an established inconsistency with the camp code "AT",
                    confirmed against real master.json data, not a typo to
                    "fix"). provrosters.json's own "Prov Team" column value
                    happens to already spell out exactly which of these it
                    is ("Alberta", "Ontario Red", "Ontario Blue", "Atlantic",
                    etc, or "0"/blank for no team) -- PROV_TEAM_LABEL maps
                    that raw value straight to the label, so Ontario's Red/
                    Blue split needs no separate case.
       U18/WNT (Canadian national tiers): "U18-C" / "WNT-C" -- unrelated to
                    province, always these two fixed strings.
     ======================================================================= */
  const PROV_CAMP_CODE = {
    'Alberta': 'AB', 'British Columbia': 'BC', 'Manitoba': 'MB',
    'Ontario': 'ON', 'Quebec': 'QC', 'Saskatchewan': 'SK', 'Atlantic': 'AT',
  };
  const PROV_TEAM_LABEL = {
    'Alberta': 'TmAB', 'British Columbia': 'TmBC', 'Manitoba': 'TmMB',
    'Ontario Red': 'TmON-R', 'Ontario Blue': 'TmON-B',
    'Quebec': 'TmQC', 'Saskatchewan': 'TmSK', 'Atlantic': 'TmAtl',
  };
  function provCampLabel(row) {
    const code = PROV_CAMP_CODE[String(row.Province || '').trim()];
    return code ? code + 'camp' : null;
  }
  function provTeamLabel(row) {
    return PROV_TEAM_LABEL[String(row['Prov Team'] || '').trim()] || null;
  }

  // Rank/label for a single ProvRosters row. U16 Prov only applies when
  // none of the U18-level flags are set (see CAMP_DATA.md: the two windows
  // never overlap for the same player in the same year, so this is a
  // fallback, not a priority order).
  function rankProvRow(row) {
    if (truthy1(row.WNT)) return { rank: 4, label: 'WNT-C' };
    if (truthy1(row['U18 Natl Camp'])) return { rank: 3, label: 'U18-C' };
    if (hasTeamValue(row['Prov Team'])) return { rank: 2, label: provTeamLabel(row) || 'Prov Team' };
    if (truthy1(row['Prov Camp'])) return { rank: 1, label: provCampLabel(row) || 'Prov Camp' };
    if (truthy1(row['U16 Prov'])) return { rank: 0, label: 'ON_U16' };
    return null;
  }

  // Token(s) a single ProvRosters row contributes -- unlike NDC, one row
  // here typically already encodes the player's whole flow for that year
  // (Prov Camp/Team/U18 Natl Camp/WNT are all columns on the SAME row), so
  // this returns every flag that's actually set, in rank order.
  function tokensForProvRow(row) {
    const out = [];
    if (truthy1(row['Prov Camp'])) out.push(provCampLabel(row) || 'Prov Camp');
    if (hasTeamValue(row['Prov Team'])) out.push(provTeamLabel(row) || 'Prov Team');
    if (truthy1(row['U18 Natl Camp'])) out.push('U18-C');
    if (truthy1(row.WNT)) out.push('WNT-C');
    if (!out.length && truthy1(row['U16 Prov'])) out.push('ON_U16');
    return out;
  }

  function canPeakForYear(rowsForYear) {
    let best = null;
    (rowsForYear || []).forEach(r => {
      const ranked = rankProvRow(r);
      if (ranked && (!best || ranked.rank > best.rank)) best = ranked;
    });
    return best; // {rank, label} or null
  }

  // Full flow string for one player-year. Sorted by rank so a genuine
  // multi-province row (or, in principle, a corrected/re-entered row) reads
  // in the right order rather than source order.
  function canFlowForYear(rowsForYear) {
    const sorted = (rowsForYear || []).slice().sort((a, b) => {
      const ra = rankProvRow(a), rb = rankProvRow(b);
      return (ra ? ra.rank : -1) - (rb ? rb.rank : -1);
    });
    const seen = new Set();
    const tokens = [];
    sorted.forEach(r => tokensForProvRow(r).forEach(t => { if (!seen.has(t)) { seen.add(t); tokens.push(t); } }));
    return tokens.join('→');
  }

  /* =======================================================================
     Cross-source consolidation -- the direct JS equivalent of PeakCamp's
     A/B/E columns (per-player-year peak, across ALL three sources) and
     G/H/I columns (per-player all-time peak).
     ======================================================================= */

  // Groups rows by a key function, returning a Map(key -> rows[]).
  function groupBy(rows, keyFn) {
    const m = new Map();
    (rows || []).forEach(r => {
      const k = keyFn(r);
      if (!k) return;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    });
    return m;
  }

  // ndcRows: full ndc.json array. provRows: full provrosters.json array.
  // intlKeys: array of "personkey|year" strings already known to be WNT-O
  // (players with no NDC/ProvRosters row at all -- pulled from Commits'
  // own WNT-O flag by the caller; this module doesn't know Commits' shape,
  // same separation of concerns as rosterClean.js not knowing D1's shape).
  //
  // Returns a Map("personkey|year" -> {personkey, year, rank, label,
  // source, detail}) -- one entry per player-year, peak across whichever
  // source(s) have data for that key.
  function buildPeakTable(ndcRows, provRows, intlKeys) {
    const ndcGroups = groupBy(ndcRows, r => r.Helper || (r.personkey && r.YEAR ? r.personkey + '|' + r.YEAR : null));
    const provGroups = groupBy(provRows, r => r['personkey helper'] || (r.personkey && r.Year ? r.personkey + '|' + r.Year : null));

    // Keys are "personkey|year", and personkey ITSELF already contains a
    // "|" (last|first) -- a naive split('|') grabs the wrong pieces (e.g.
    // "biotti|emilia|2024" -> ["biotti","emilia"] instead of
    // ["biotti|emilia","2024"]). Split on the LAST "|" only.
    function splitKey(key) {
      const i = key.lastIndexOf('|');
      return i === -1 ? [key, ''] : [key.slice(0, i), key.slice(i + 1)];
    }

    const table = new Map();
    const setIfBetter = (key, personkey, year, ranked, source, detail) => {
      if (!ranked) return;
      const existing = table.get(key);
      if (!existing || ranked.rank > existing.rank) {
        table.set(key, { personkey, year, rank: ranked.rank, label: ranked.label, source, detail });
      }
    };

    ndcGroups.forEach((rows, key) => {
      const [personkey, year] = splitKey(key);
      setIfBetter(key, personkey, year, usPeakForYear(rows), 'US', usFlowForYear(rows));
    });
    provGroups.forEach((rows, key) => {
      const [personkey, year] = splitKey(key);
      setIfBetter(key, personkey, year, canPeakForYear(rows), 'CAN', canFlowForYear(rows));
    });
    (intlKeys || []).forEach(key => {
      const [personkey, year] = splitKey(String(key));
      if (!personkey || !year) return;
      setIfBetter(key, personkey, year, { rank: 4, label: 'WNT-O' }, 'Intl', 'WNT-O');
    });

    return table;
  }

  /* =======================================================================
     "Frozen in time" / historical-commitment rules (US/NDC only -- CAN's
     provrosters.json has no equivalent documented announcement-date
     source, so this does NOT apply to Canadian players).

     A commit record is supposed to reflect a player's camp attainment AS
     KNOWN AT THE MOMENT OF COMMITMENT (her "Date Added" in commits.json),
     not her current/live progress -- e.g. a player who later made WNT but
     committed before that year's WNT announcement should freeze at
     whatever was the highest tier already public on her commit date.

     ANNOUNCE_DATES: real USA Hockey notification dates, one entry per
     camp-cycle calendar year. 'may' = U15/U1617 notifications AND the
     initial partial U18 list (same day every year on record). 'jul' = the
     date the FULL U18/Festival roster is public (NDC's "U18" camp record
     is treated as equivalent to Festival attendance) -- a player only
     counts as "known U18" at the earlier 'may' date if her U18 record that
     year has NO matching U1617 record the same year (i.e. she was invited
     straight to U18/Festival, not promoted from U1617 mid-cycle); otherwise
     U18 isn't knowable until 'jul'. 'aug' = the U18 Select Team vs. Canada
     cut (= NDC's WNT flag); null for 2021 specifically -- that series did
     not happen (COVID), so WNT can never be "known" for a 2021 camp-year
     regardless of commit date.

     Sourced from real USA Hockey notification guides/press releases
     (2021-2022) and Paulash's own records (2023-2026); confirmed with him
     turn-by-turn against real NDC rows before being locked in here --
     see the Sept/Oct 2026 "freeze in time" conversation in chat history.
     If a future year's dates aren't added here yet, that year's slot is
     just never resolvable (stays blank), same as a year with no data at
     all -- never silently guessed. ======================================================================= */
  const ANNOUNCE_DATES = {
    2021: { may: '6/9/2021',  jul: '7/23/2021', aug: null },        // no Canada series (COVID)
    2022: { may: '5/25/2022', jul: '7/21/2022', aug: '8/14/2022' },
    2023: { may: '5/24/2023', jul: '6/30/2023', aug: '8/13/2023' },
    2024: { may: '5/23/2024', jul: '7/24/2024', aug: '8/12/2024' },
    2025: { may: '5/22/2025', jul: '7/28/2025', aug: '8/10/2025' },
    2026: { may: '5/21/2026', jul: '7/27/2026', aug: '8/10/2026' },
  };
  const TIER_RANK = { U15: 1, U1617: 2, U18: 3, WNT: 4 };

  function parseMDY(s) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim());
    if (!m) return null;
    return new Date(+m[3], +m[1] - 1, +m[2]);
  }

  // Given one calendar year's raw NDC rows for a single player (may contain
  // a U15 row, a U1617 row, a U18 row, or U1617+U18 together) and a commit
  // date, returns the single highest tier label knowable as of that date
  // for THAT YEAR ONLY -- e.g. "U1617" if she'd made U1617 but her U18/WNT
  // results that same year weren't public yet on the commit date. Returns
  // "" if nothing from that year was knowable yet (including if the year
  // has no ANNOUNCE_DATES entry at all).
  function frozenUsTierForYear(yearRows, dateAddedStr) {
    const dates = ANNOUNCE_DATES[yearRows && yearRows.length ? +yearRows[0].YEAR : null];
    const da = parseMDY(dateAddedStr);
    if (!dates || !da) return '';
    const camps = new Set((yearRows || []).map(r => String(r.CAMP || '').trim()));
    const wnt = (yearRows || []).some(r => String(r.CAMP || '').trim() === 'U18' && truthy1(r.WNT));
    const knowable = [];
    if (camps.has('U15') && parseMDY(dates.may) <= da) knowable.push('U15');
    if (camps.has('U1617') && parseMDY(dates.may) <= da) knowable.push('U1617');
    if (camps.has('U18')) {
      const u18Date = camps.has('U1617') ? dates.jul : dates.may;
      if (parseMDY(u18Date) <= da) knowable.push('U18');
    }
    if (wnt && dates.aug && parseMDY(dates.aug) <= da) knowable.push('WNT');
    if (!knowable.length) return '';
    return knowable.reduce((best, t) => (TIER_RANK[t] > TIER_RANK[best] ? t : best));
  }

  /* =======================================================================
     CAN (ProvRosters) "frozen in time" rules -- analogous to the US/NDC
     ones above, but on Hockey Canada's own national-team dates (U18-C /
     WNT-C) plus Paulash's explicit simplifying assumption for the
     provincial-level tiers, since real provincial-camp/team announcement
     dates vary too much by province to track individually:
       - Prov Camp (XXcamp, rank 1) assumed known as of July 1 that year.
       - Prov Team (TmXX, rank 2) assumed known as of October 15 that year.
       - ON_U16 (rank 0) has no date of its own either -- treated the same
         as Prov Camp (July 1) since it's the same age-13/14 tier of event,
         just Ontario-specific; not an explicit instruction, flagging the
         assumption here rather than burying it.
     U18-C / WNT-C dates are real Hockey Canada roster-announcement dates
     (hockeycanada.ca news posts, one per summer cycle); 2021 has no WNT-C
     date -- no summer series vs. the US that year (COVID), so WNT-C can
     never be "known" for a 2021 camp-year regardless of commit date, same
     treatment as the US table's 2021 WNT gap.
     ======================================================================= */
  const CAN_ANNOUNCE_DATES = {
    2021: { provCamp: '7/1/2021',  provTeam: '10/15/2021', u18c: '7/9/2021',  wntc: null },
    2022: { provCamp: '7/1/2022',  provTeam: '10/15/2022', u18c: '7/29/2022', wntc: '8/14/2022' },
    2023: { provCamp: '7/1/2023',  provTeam: '10/15/2023', u18c: '7/14/2023', wntc: '8/13/2023' },
    2024: { provCamp: '7/1/2024',  provTeam: '10/15/2024', u18c: '8/1/2024',  wntc: '8/11/2024' },
    2025: { provCamp: '7/1/2025',  provTeam: '10/15/2025', u18c: '7/29/2025', wntc: '8/10/2025' },
    2026: { provCamp: '7/1/2026',  provTeam: '10/15/2026', u18c: '7/31/2026', wntc: '8/9/2026' },
  };
  const CAN_TIER_RANK = { ON_U16: 0 }; // provincial camp/team labels vary by
  // province (ABcamp/TmAB, etc.) -- ranked by TIER KIND below, not by label.

  // Given one calendar year's raw ProvRosters row(s) for a single player
  // and a commit date, returns the single highest tier label knowable as
  // of that date for THAT YEAR ONLY. Mirrors frozenUsTierForYear's shape
  // and return convention ("" if nothing from that year was knowable yet).
  function frozenCanTierForYear(yearRows, dateAddedStr) {
    const dates = CAN_ANNOUNCE_DATES[yearRows && yearRows.length ? +yearRows[0].Year : null];
    const da = parseMDY(dateAddedStr);
    if (!dates || !da) return '';
    const knowable = []; // [{rank, label}]
    (yearRows || []).forEach(row => {
      if (truthy1(row['U16 Prov']) && parseMDY(dates.provCamp) <= da) knowable.push({ rank: 0, label: 'ON_U16' });
      if (truthy1(row['Prov Camp']) && parseMDY(dates.provCamp) <= da) knowable.push({ rank: 1, label: provCampLabel(row) || 'Prov Camp' });
      if (hasTeamValue(row['Prov Team']) && parseMDY(dates.provTeam) <= da) knowable.push({ rank: 2, label: provTeamLabel(row) || 'Prov Team' });
      if (truthy1(row['U18 Natl Camp']) && parseMDY(dates.u18c) <= da) knowable.push({ rank: 3, label: 'U18-C' });
      if (truthy1(row.WNT) && dates.wntc && parseMDY(dates.wntc) <= da) knowable.push({ rank: 4, label: 'WNT-C' });
    });
    if (!knowable.length) return '';
    return knowable.reduce((best, t) => (t.rank > best.rank ? t : best)).label;
  }

  // Rolls a peak-table (from buildPeakTable) up to one row per PLAYER --
  // their single all-time-best rank/label across every year they appear in
  // -- the equivalent of PeakCamp's G/H/I columns. Ties keep whichever was
  // seen first (arbitrary but deterministic given a stable input order).
  function buildOverallPeakByPlayer(peakTable) {
    const out = new Map();
    peakTable.forEach(entry => {
      const existing = out.get(entry.personkey);
      if (!existing || entry.rank > existing.rank) out.set(entry.personkey, entry);
    });
    return out;
  }

  return {
    truthy1, hasTeamValue,
    rankNDCRow, tokensForNDCRow, usPeakForYear, usFlowForYear,
    rankProvRow, tokensForProvRow, canPeakForYear, canFlowForYear,
    groupBy, buildPeakTable, buildOverallPeakByPlayer,
    ANNOUNCE_DATES, frozenUsTierForYear,
    CAN_ANNOUNCE_DATES, frozenCanTierForYear,
  };
});
