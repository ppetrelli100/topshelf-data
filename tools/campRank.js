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
     ======================================================================= */

  // Rank/label for a single ProvRosters row. U16 Prov only applies when
  // none of the U18-level flags are set (see CAMP_DATA.md: the two windows
  // never overlap for the same player in the same year, so this is a
  // fallback, not a priority order).
  function rankProvRow(row) {
    if (truthy1(row.WNT)) return { rank: 4, label: 'WNT' };
    if (truthy1(row['U18 Natl Camp'])) return { rank: 3, label: 'U18 Natl Camp' };
    if (hasTeamValue(row['Prov Team'])) return { rank: 2, label: 'Prov Team' };
    if (truthy1(row['Prov Camp'])) return { rank: 1, label: 'Prov Camp' };
    if (truthy1(row['U16 Prov'])) return { rank: 0, label: 'ON_U16' };
    return null;
  }

  // Token(s) a single ProvRosters row contributes -- unlike NDC, one row
  // here typically already encodes the player's whole flow for that year
  // (Prov Camp/Team/U18 Natl Camp/WNT are all columns on the SAME row), so
  // this returns every flag that's actually set, in rank order.
  function tokensForProvRow(row) {
    const out = [];
    if (truthy1(row['Prov Camp'])) out.push('Prov Camp');
    if (hasTeamValue(row['Prov Team'])) out.push('Prov Team');
    if (truthy1(row['U18 Natl Camp'])) out.push('U18 Natl Camp');
    if (truthy1(row.WNT)) out.push('WNT');
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
  };
});
