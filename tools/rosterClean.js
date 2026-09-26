/* =========================================================================
   rosterClean.js — HockeyFile / TopShelf: the ONE canonical set of rules
   for turning a raw pasted/scraped roster row into what colrosters.json
   (and personkeys generally) expect.

   This file is the single source of truth. Three surfaces run it:
     1. updates.html          — loads this via <script src="...rosterClean.js">
     2. collegeview.html      — same, for the live-vs-site "recheck" button
     3. an AI assistant (Claude or otherwise) asked to clean a pasted
        roster screenshot — fetch this file's raw contents plus
        firstNameMap.json and d1.json from GitHub, run it under Node, and
        apply the same functions. See tools/ROSTER_CLEANUP.md for the
        step-by-step instructions written for that case.

   Do NOT copy/paste this logic inline anywhere else. If a rule needs to
   change (a new name tag to strip, a new state abbreviation, a new
   override), change it here — every surface picks it up automatically
   the next time it fetches this file.

   Works both as a browser <script> (attaches everything to
   window.RosterClean) and under Node (module.exports = RosterClean).
   ========================================================================= */
(function (root, factory) {
  const RosterClean = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RosterClean;
  }
  if (typeof window !== 'undefined') {
    window.RosterClean = RosterClean;
  }
})(this, function () {
  'use strict';

  /* =======================================================================
     0. Alias / override tables — loaded from firstNameMap.json by the
        caller and handed in via setNameMaps(). Not shipped in this file
        because they change independently (new player disambiguation,
        new nickname alias) and live in firstNameMap.json on GitHub.
     ======================================================================= */
  let ALIAS_MAP = {};     // alias -> canon first name
  let OVERRIDE_MAP = {};  // "lastname|canonfirst" -> "lastname|overriddenfirst"
  let PK_EXC = [];        // [{pk, school, to}] — school-aware exceptions

  function setNameMaps(firstNameMapJson) {
    ALIAS_MAP = {};
    OVERRIDE_MAP = {};
    PK_EXC = [];
    const fnm = firstNameMapJson || {};
    (fnm.aliases || []).forEach(a => { ALIAS_MAP[a.alias.toLowerCase()] = a.canon.toLowerCase(); });
    (fnm.overrides || []).forEach(o => { OVERRIDE_MAP[o.from.toLowerCase()] = o.to.toLowerCase(); });
    PK_EXC = (fnm.pkExceptions || []).map(x => ({
      pk: x.pk.toLowerCase(), school: x.school.toLowerCase(), to: x.to.toLowerCase(),
    }));
  }

  // Called after a player's base personkey is built, when the school is
  // known (colrosters context) — applies a {pk, school, to} exception, e.g.
  // king|olivia at Maine -> king|oliviame. Not usable from the Sheet's
  // MAKEPERSONKEY (no school column there); those disambiguations stay as
  // plain PK_Override rows on the Sheet side instead.
  function applyPkException(pk, school) {
    if (!school) return pk;
    const hit = PK_EXC.find(e => e.pk === pk && e.school === school.toLowerCase());
    return hit ? hit.to : pk;
  }

  /* =======================================================================
     1. Name cleanup — accents, audio-link junk, trailing status tags.
     ======================================================================= */

  // Roster pages like Bemidji's append an audio-link label to each name,
  // e.g. "Kaitlin GroessHear how to pronounce Kaitlin Groess". Drop it (and
  // anything after it) before the name is used or turned into a personkey.
  function stripPronounce(name) {
    return (name || '').replace(/\s*Hear how to pronounce[\s\S]*$/i, '').trim();
  }

  function unaccent(text) {
    if (!text) return text;
    text = text.replace(/œ/g, 'oe').replace(/Œ/g, 'OE').replace(/æ/g, 'ae').replace(/Æ/g, 'AE');
    return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  // Trailing status tags some rosters append to a name: "AP" / "A.P."
  // (Canadian alternate player) and "Injured", with or without parens
  // (e.g. "Jane Simeon (Injured)", "Marshall AP"). They are not part of the
  // name, so makePersonKey drops them; nameTags() reports what was there so
  // the parser/reviewer can flag it (flag it — never silently discard the
  // fact that a row was tagged).
  const NAME_TAG_RE = /(\s*\(\s*(injured|a\.?p\.?)\s*\)|\s+(injured|a\.?p\.?))+\s*$/i;

  function stripNameTags(full) {
    const t = (full || '').trim();
    const r = t.replace(NAME_TAG_RE, '').trim();
    // Safety guard: only strip if something meaningful is left. A player
    // whose real (unusual) last name IS "Ap" keeps it.
    return /\s/.test(r) ? r : t;
  }

  function nameTags(full) {
    const t = (full || '').trim().match(NAME_TAG_RE);
    if (!t || stripNameTags(full) === (full || '').trim()) return [];
    const out = [];
    if (/a\.?p\.?/i.test(t[0].replace(/injured/ig, ''))) out.push('AP');
    if (/injured/i.test(t[0])) out.push('Injured');
    return out;
  }

  /* =======================================================================
     2. Personkey construction — lastname|firstname, lowercase a-z only.
     ======================================================================= */
  function makePersonKey(full) {
    full = unaccent(stripNameTags(full));
    const m = full.match(/^(\S+)\s+(.*)$/);
    if (!m) return (full || '').toLowerCase() + '|';
    const first = m[1];
    let last = m[2];
    last = last.toLowerCase().replace(/[^a-z]/g, '');
    let firstLower = first.toLowerCase().replace(/\(.*$/, '').replace(/[^a-z]/g, '');
    const canon = ALIAS_MAP[firstLower] || firstLower;
    const key = last + '|' + canon;
    return OVERRIDE_MAP[key] || key;
  }

  function firstNameWasCanonicalized(fullName) {
    const full = unaccent(stripNameTags(fullName));
    const m = full.match(/^(\S+)\s+(.*)$/);
    if (!m) return false;
    const firstLower = m[1].toLowerCase().replace(/[^a-z]/g, '');
    return !!(ALIAS_MAP && ALIAS_MAP[firstLower] && ALIAS_MAP[firstLower] !== firstLower);
  }

  function splitFirstLast(name) {
    const m = (name || '').trim().match(/^(\S+)\s+(.*)$/);
    if (!m) return { first: (name || '').trim(), last: '' };
    return { first: m[1], last: m[2] };
  }

  // Nicknames that map to several genuinely different canonical first names
  // (unlike "Abby"->Abigail, which only ever means one thing). Anyone with
  // one of these as a first name gets flagged instead of silently trusted —
  // "Madi" alone could be Madison, Madelyn, Madeline, or Madyson, and only
  // that specific player's own history (or asking them) can settle it.
  const AMBIGUOUS_NICKNAMES = new Set(['madi', 'maddie', 'maddi', 'maddy']);

  function computeAmbigIssue(name, pk, pkManual, findHistoricalPksForLastName) {
    if (pkManual) return ''; // a hand-typed pk IS the confirmation
    const firstToken = (name || '').split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
    if (!AMBIGUOUS_NICKNAMES.has(firstToken)) return '';
    const lastName = (pk || '').split('|')[0];
    const alts = (findHistoricalPksForLastName ? findHistoricalPksForLastName(lastName, pk) : []) || [];
    return `Ambiguous nickname (guessed ${pk}) — ` +
      (alts.length ? `history has ${alts.join(', ')} for this last name, confirm which one this is.`
                   : `no record for this last name in history, confirm the full first name.`);
  }

  /* =======================================================================
     3. Position / class-year / height normalization.
     ======================================================================= */

  // Every position spelling ever seen on a site table, collapsed to F/D/G —
  // colrosters.json never stores C/LW/RW/A/RD/LD/etc, just the three groups.
  const POS_MAP = {
    'f': 'F', 'forward': 'F', 'fwd': 'F', 'c': 'F', 'center': 'F', 'centre': 'F',
    'lw': 'F', 'rw': 'F', 'a': 'F', 'attack': 'F', 'attacker': 'F',
    'd': 'D', 'defense': 'D', 'defender': 'D', 'defence': 'D', 'defenseman': 'D', 'defenceman': 'D',
    'rd': 'D', 'ld': 'D',
    'g': 'G', 'goalie': 'G', 'goaltender': 'G', 'gk': 'G',
  };
  function normalizePos(p) {
    const clean = (p || '').replace(/\.$/, '').trim();
    return POS_MAP[clean.toLowerCase()] || clean;
  }

  const YEAR_MAP = {
    'fy': 'Fr', 'fr': 'Fr', 'freshman': 'Fr', '1st': 'Fr',
    'so': 'So', 'soph': 'So', 'sophomore': 'So', '2nd': 'So',
    'jr': 'Jr', 'junior': 'Jr', '3rd': 'Jr',
    'sr': 'Sr', 'senior': 'Sr', '4th': 'Sr',
    '5th': '5th', 'fifth': '5th', 'super senior': '5th', '5th year': '5th',
    'gr': 'Gr', 'grad': 'Gr', 'graduate': 'Gr', 'graduate student': 'Gr', 'grad student': 'Gr', 'grad. student': 'Gr', 'graduate st': 'Gr',
  };
  function normalizeYear(y) {
    const clean = (y || '').replace(/\.$/, '').trim();
    // Redshirt prefixes (R-Fr, R-So, ...) keep the R- and normalize the rest.
    const rMatch = clean.match(/^r-?\s*(.+)$/i);
    if (rMatch) {
      const base = YEAR_MAP[rMatch[1].toLowerCase()] || rMatch[1];
      return 'R-' + base;
    }
    // "Fifth Year" / "Fifth-Year" / "5th Year" -> the stored 5th.
    if (/^(fifth|5th)[\s-]*year$/i.test(clean)) return '5th';
    return YEAR_MAP[clean.toLowerCase()] || clean;
  }

  // Height -> "F-I" (the colrosters.json format). Accepts 5' 8", 5'8", 5-8,
  // 5' 8, 5 ft 8 in. Inches above 11 (e.g. a site typo like 5' 19") are
  // rejected: value comes back blank with an issue message so the person
  // fixes it by hand instead of a bad height going live.
  function normHeight(raw) {
    const t = (raw || '').replace(/[’‘′]/g, "'").replace(/[”“″]/g, '"').replace(/''/g, '"').trim();
    if (!t) return { value: '', issue: '' };
    const m = t.match(/^(\d)\s*(?:'|-|ft\.?|feet)\s*(\d{1,2})?\s*(?:"|in\.?|inches)?$/i);
    if (!m) return { value: t, issue: '' }; // unknown shape: keep as pasted
    const ft = m[1], inch = m[2] == null ? '0' : m[2];
    if (parseInt(inch, 10) > 11) return { value: '', issue: `Height "${t}" isn't valid (inches over 11) — fix the Ht cell.` };
    return { value: `${ft}-${inch}`, issue: '' };
  }

  /* =======================================================================
     4. Hometown / state / country parsing.
     ======================================================================= */
  const US_STATE_ABBR = {
    'Ala.': 'AL', 'Alaska': 'AK', 'Ariz.': 'AZ', 'Ark.': 'AR', 'Calif.': 'CA', 'Colo.': 'CO', 'Conn.': 'CT',
    'Del.': 'DE', 'Fla.': 'FL', 'Ga.': 'GA', 'Hawaii': 'HI', 'Idaho': 'ID', 'Id.': 'ID', 'Ill.': 'IL', 'Ind.': 'IN',
    'Iowa': 'IA', 'Kan.': 'KS', 'Ky.': 'KY', 'La.': 'LA', 'Maine': 'ME', 'Md.': 'MD', 'Mass.': 'MA', 'Mich.': 'MI',
    'Minn.': 'MN', 'Miss.': 'MS', 'Mo.': 'MO', 'Mont.': 'MT', 'Neb.': 'NE', 'Nebr.': 'NE', 'Nebraska': 'NE',
    'Nev.': 'NV', 'N.H.': 'NH', 'N.J.': 'NJ', 'N.M.': 'NM', 'N.Y.': 'NY', 'N.C.': 'NC', 'N.D.': 'ND', 'Ohio': 'OH',
    'Okla.': 'OK', 'Ore.': 'OR', 'Pa.': 'PA', 'R.I.': 'RI', 'S.C.': 'SC', 'S.D.': 'SD', 'Tenn.': 'TN', 'Texas': 'TX',
    'Utah': 'UT', 'Vt.': 'VT', 'Va.': 'VA', 'Wash.': 'WA', 'W.Va.': 'WV', 'Wis.': 'WI', 'Wyo.': 'WY',
  };
  Array.from(new Set(Object.values(US_STATE_ABBR))).forEach(code => { if (!(code in US_STATE_ABBR)) US_STATE_ABBR[code] = code; });

  const CANADA_PROVINCE = {
    'Ontario': 'ON', 'Ont.': 'ON', 'Quebec': 'QC', 'Que.': 'QC', 'Manitoba': 'MB', 'Man.': 'MB',
    'Saskatchewan': 'SK', 'Sask.': 'SK', 'British Columbia': 'BC', 'B.C.': 'BC', 'New Brunswick': 'NB',
    'N.B.': 'NB', 'Nova Scotia': 'NS', 'N.S.': 'NS', 'Prince Edward Island': 'PE', 'P.E.I.': 'PE',
    'Newfoundland': 'NL', 'Alberta': 'AB', 'Alta.': 'AB', 'Alb.': 'AB', 'Northwest Territories': 'NT',
  };

  const COUNTRY_CONTINENT = {
    Austria: 'Europe', 'Czech Republic': 'Europe', Czechia: 'Europe', Denmark: 'Europe', Finland: 'Europe',
    France: 'Europe', Germany: 'Europe', Hungary: 'Europe', Italy: 'Europe', Latvia: 'Europe', Norway: 'Europe',
    Poland: 'Europe', Russia: 'Europe', Slovakia: 'Europe', Spain: 'Europe', Sweden: 'Europe', Switzerland: 'Europe',
    China: 'Asia', Japan: 'Asia', 'South Korea': 'Asia',
  };

  const US_FULL_TO_ABBR = {
    'Alaska': 'AK', 'Alabama': 'AL', 'Arkansas': 'AR', 'Arizona': 'AZ', 'California': 'CA', 'Colorado': 'CO',
    'Connecticut': 'CT', 'Delaware': 'DE', 'Florida': 'FL', 'Georgia': 'GA', 'Hawaii': 'HI', 'Iowa': 'IA', 'Idaho': 'ID',
    'Illinois': 'IL', 'Indiana': 'IN', 'Kansas': 'KS', 'Kentucky': 'KY', 'Louisiana': 'LA', 'Massachusetts': 'MA',
    'Maryland': 'MD', 'Maine': 'ME', 'Michigan': 'MI', 'Minnesota': 'MN', 'Missouri': 'MO', 'Mississippi': 'MS',
    'Montana': 'MT', 'North Carolina': 'NC', 'North Dakota': 'ND', 'Nebraska': 'NE', 'New Hampshire': 'NH',
    'New Jersey': 'NJ', 'New Mexico': 'NM', 'Nevada': 'NV', 'New York': 'NY', 'Ohio': 'OH', 'Oklahoma': 'OK',
    'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD',
    'Tennessee': 'TN', 'Texas': 'TX', 'Utah': 'UT', 'Virginia': 'VA', 'Vermont': 'VT', 'Washington': 'WA',
    'Wisconsin': 'WI', 'West Virginia': 'WV', 'Wyoming': 'WY',
  };
  const CA_FULL_TO_ABBR = {
    'Alberta': 'AB', 'British Columbia': 'BC', 'Manitoba': 'MB', 'New Brunswick': 'NB', 'Newfoundland': 'NL',
    'Newfoundland and Labrador': 'NL', 'Northwest Territories': 'NT', 'Nova Scotia': 'NS',
    'Nunavut': 'NU', 'Ontario': 'ON', 'Prince Edward Island': 'PE', 'Quebec': 'QC', 'Saskatchewan': 'SK', 'Yukon': 'YT',
  };
  const REGION_FULL_TO_ABBR = Object.assign({}, US_FULL_TO_ABBR, CA_FULL_TO_ABBR);
  const REGION_ABBR_OK = new Set(Object.values(REGION_FULL_TO_ABBR));
  const COUNTRY_WORDS = new Set(['canada', 'can', 'usa', 'us', 'united states']);

  // Site-copy cleanup: literal "null"/"N/A" cells, stray whitespace.
  function cleanCell(v) {
    const t = (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
    return /^(null|n\/a|none|-|—)$/i.test(t) ? '' : t;
  }

  let _regionLookup = null;
  function regionLookup() {
    if (_regionLookup) return _regionLookup;
    const k = v => v.replace(/\./g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const L = { us: {}, ca: {} };
    Object.keys(US_STATE_ABBR).forEach(n => { L.us[k(n)] = US_STATE_ABBR[n]; });
    Object.keys(US_FULL_TO_ABBR).forEach(n => { L.us[k(n)] = US_FULL_TO_ABBR[n]; });
    Object.keys(CANADA_PROVINCE).forEach(n => { L.ca[k(n)] = CANADA_PROVINCE[n]; });
    // Always land on the standard 2-letter code: accept the codes themselves,
    // plus the spellings the lookup tables above don't list.
    ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'].forEach(c => { L.ca[k(c)] = c; });
    Object.entries({
      'newfoundland and labrador': 'NL', 'nfld': 'NL', 'n l': 'NL', 'labrador': 'NL', 'pei': 'PE', 'prince edward island': 'PE',
      'yukon': 'YT', 'y t': 'YT', 'yukon territory': 'YT', 'nunavut': 'NU', 'nvt': 'NU', 'nwt': 'NT', 'n w t': 'NT', 'northwest territories': 'NT',
      'pq': 'QC', 'quebec': 'QC', 'que': 'QC', 'ont': 'ON', 'alta': 'AB', 'sask': 'SK', 'man': 'MB',
    }).forEach(([a, c]) => { L.ca[a] = c; });
    Object.entries({ 'dc': 'DC', 'd c': 'DC', 'washington dc': 'DC', 'district of columbia': 'DC' }).forEach(([a, c]) => { L.us[a] = c; });
    // Longer AP-style spellings some sites use ("Wisc.", "Penn.", "Ida.", "Tex.").
    Object.entries({ 'wisc': 'WI', 'penn': 'PA', 'ida': 'ID', 'tex': 'TX' }).forEach(([a, c]) => { L.us[a] = c; });
    Object.keys(CA_FULL_TO_ABBR).forEach(n => { L.ca[k(n)] = CA_FULL_TO_ABBR[n]; });
    L.k = k;
    return (_regionLookup = L);
  }

  function parseHometown(raw) {
    // Unaccent up front -- region/country/province names get matched against
    // plain-ASCII dictionary keys below (e.g. "Québec" -> "Quebec"), and city
    // names are stored unaccented everywhere else in colrosters.json too.
    raw = unaccent(raw || '');
    // Split "hometown / last team". Sites that space the slash ("Town, St. / Team")
    // may also have a slash INSIDE a team name ("CPC/NA Elite"), so prefer the
    // first spaced slash; only fall back to the first bare slash for sites
    // that write "Town, State/Team".
    let homePart, prevSchool;
    const sp = raw.search(/\s\/(\s|$)/);
    if (sp !== -1) { homePart = raw.slice(0, sp); prevSchool = raw.slice(sp).replace(/^\s\/\s*/, ''); }
    else { const i = raw.indexOf('/'); homePart = i === -1 ? raw : raw.slice(0, i); prevSchool = i === -1 ? '' : raw.slice(i + 1); }
    homePart = homePart.trim().replace(/[,\s]+$/, '');
    prevSchool = cleanCell(prevSchool);
    const segments = homePart.split(',').map(s => s.trim());
    if (segments.length >= 3 && /^canada$/i.test(segments[segments.length - 1])) {
      const province = segments[segments.length - 2];
      const home = segments.slice(0, segments.length - 2).join(', ');
      const provCode = CANADA_PROVINCE[province] || regionLookup().ca[regionLookup().k(province)];
      if (provCode) return { home, st: provCode, ctry: 'Canada', prevSchool };
      return { home, st: province, ctry: '__UNKNOWN__', prevSchool };
    }
    const commaIdx = homePart.lastIndexOf(',');
    if (commaIdx === -1) return { home: homePart, st: '', ctry: '', prevSchool };
    const home = homePart.slice(0, commaIdx).trim();
    const regionRaw = homePart.slice(commaIdx + 1).trim();
    const RL = regionLookup(), rk = RL.k(regionRaw);
    // Country only ("Toronto, Canada" / "Boston, USA"): no state/province on the page, so leave it blank.
    if (/^(canada|can)$/i.test(regionRaw.replace(/\.$/, ''))) return { home, st: '', ctry: 'Canada', prevSchool };
    if (/^(usa|u\.?s\.?a?\.?|united states)$/i.test(regionRaw)) return { home, st: '', ctry: 'US', prevSchool };
    if (RL.us[rk]) return { home, st: RL.us[rk], ctry: 'US', prevSchool };
    if (RL.ca[rk]) return { home, st: RL.ca[rk], ctry: 'Canada', prevSchool };
    // Truncated spellings ("Illi.", "Wisc.", "Penn.", "Tex."): accept 3+ letters that begin exactly one
    // full state/province name (unambiguous only -- "Mis." could be Missouri or Mississippi, so it stays flagged).
    if (rk.length >= 3) {
      const uniq = (map) => { const hits = new Set(Object.keys(map).filter(n => n.length > 3 && n.startsWith(rk)).map(n => map[n])); return hits.size === 1 ? [...hits][0] : null; };
      const u = uniq(RL.us), c = uniq(RL.ca);
      if (u && !c) return { home, st: u, ctry: 'US', prevSchool };
      if (c && !u) return { home, st: c, ctry: 'Canada', prevSchool };
    }
    // 3-letter country codes some sites use (e.g. "Lovosice, CZE").
    // AUS: Merrimack's roster page uses "Aus." for Austria (confirmed for Emma Pfeffer, Vienna); Australia isn't a supported country here.
    const ISO3 = { AUT: 'Austria', AUS: 'Austria', CZE: 'Czech Republic', DNK: 'Denmark', DEN: 'Denmark', FIN: 'Finland', FRA: 'France', GER: 'Germany', DEU: 'Germany',
      HUN: 'Hungary', ITA: 'Italy', LAT: 'Latvia', LVA: 'Latvia', NOR: 'Norway', POL: 'Poland', RUS: 'Russia', SVK: 'Slovakia', ESP: 'Spain',
      SWE: 'Sweden', SUI: 'Switzerland', CHE: 'Switzerland', CHN: 'China', JPN: 'Japan', KOR: 'South Korea' };
    const iso = ISO3[regionRaw.replace(/\.$/, '').toUpperCase()];
    if (iso) return { home, st: iso, ctry: COUNTRY_CONTINENT[iso], prevSchool };
    // Other countries: stored as the country name in normal capitalization.
    const cn = Object.keys(COUNTRY_CONTINENT).find(n => n.toLowerCase() === regionRaw.replace(/\.$/, '').toLowerCase());
    if (cn) return { home, st: cn, ctry: COUNTRY_CONTINENT[cn], prevSchool };
    return { home, st: regionRaw, ctry: '__UNKNOWN__', prevSchool };
  }

  // Team-roster paste variant: separate State and Hometown cells, incl. the
  // "Canada"/"CAN" ends-up-in-the-state-cell case (fixed by pulling the
  // real province from a 2-part hometown string when present).
  function normalizeStateAndHometown(rawState, rawHometown) {
    let home = unaccent(rawHometown || '').trim();
    let state = unaccent(rawState || '').trim();
    const origStateTrim = state;
    let countryMoved = false; // a country word (e.g. "Canada") was found in
                               // Hometown or State and resolved out of State,
                               // rather than left sitting there as-is

    if (home.includes(',')) {
      const parts = home.split(',').map(s => s.trim());
      const last = parts[parts.length - 1];
      if (COUNTRY_WORDS.has(last.toLowerCase()) && parts.length >= 2) {
        const prov = parts[parts.length - 2];
        home = parts.slice(0, parts.length - 2).join(', ');
        if (!state) state = prov;
        countryMoved = true;
      } else {
        home = parts.slice(0, parts.length - 1).join(', ');
        if (!state) state = last;
      }
    }

    // The State/Province column itself sometimes carries "Province, Country"
    // (e.g. "Ontario, Canada") when there's no separate Hometown column to
    // pull the province from — same fix as the "Canada"/"CAN" case, just
    // applied directly to the state cell instead of a split-off hometown.
    if (state.includes(',')) {
      const parts = state.split(',').map(s => s.trim());
      const last = parts[parts.length - 1];
      if (COUNTRY_WORDS.has(last.toLowerCase()) && parts.length >= 2) {
        state = parts[parts.length - 2];
        countryMoved = true;
      } else {
        state = last;
      }
    }

    if (state) {
      if (REGION_ABBR_OK.has(state.toUpperCase())) {
        state = state.toUpperCase();
      } else if (REGION_FULL_TO_ABBR[state]) {
        state = REGION_FULL_TO_ABBR[state];
      } else if (COUNTRY_WORDS.has(state.toLowerCase())) {
        state = '';
        countryMoved = true;
      } else if (/^[A-Za-z]{2}$/.test(state)) {
        state = state.toUpperCase();
      } else {
        state = '';
      }
    }
    const stateNormalized = state !== origStateTrim && !!(state || origStateTrim);
    return { home, state, countryMoved, stateNormalized };
  }

  /* =======================================================================
     5. Committed-school normalization — matched against a live D1 list.
     ======================================================================= */
  function normCommitted(raw, D1) {
    const trimmed = (raw || '').trim();
    if (!trimmed) return { value: '', matched: true };
    if (D1 && D1[trimmed]) return { value: trimmed, matched: true };

    const names = D1 ? Object.keys(D1) : [];
    const lower = trimmed.toLowerCase();
    let hit = names.find(n => n.toLowerCase() === lower);
    if (hit) return { value: hit, matched: true };

    const strip = s => s.toLowerCase().replace(/\b(university|college)\b/g, '').replace(/[^a-z]/g, '');
    const target = strip(trimmed);
    hit = names.find(n => strip(n) === target);
    if (hit) return { value: hit, matched: true };

    return { value: trimmed, matched: false };
  }

  /* =======================================================================
     6. Live-site table extraction — for the collegeview.html "validate"
        button. Pure string/regex parsing (no DOM dependency), so this runs
        identically in a browser, under Node, or inside a fetch-proxying
        Cloudflare Worker. Sidearm Sports roster pages (confirmed across all
        45 current D1 schools, Sept 2026) render the roster as one plain
        <table> with a header row; this finds that table, matches its
        headers the same loose way updates.html matches pasted headers, and
        extracts rows in the same shape buildRecord() in updates.html
        produces: {name, pk, y, pos, ht, home, st, ctry, no, sh, prevSchool}.
     ======================================================================= */

  // Shoots/catches: colrosters.json stores plain L or R (goalies too), so
  // "Catch L", "Catches Left", "Left" all become L.
  function normShoots(v) {
    const m = String(v || '').trim().match(/^(?:catch(?:es)?\s*)?(?:glove\s*)?(l|r|left|right)$/i);
    return m ? m[1][0].toUpperCase() : String(v || '').trim();
  }

  function stripHtmlTags(s) {
    return (s || '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      // Named accent entities on names, e.g. &zcaron; &eacute; &oslash; -- otherwise
      // "Ane&zcaron;ka" comes through literally and the pk never matches.
      .replace(/&([A-Za-z])(acute|grave|circ|uml|tilde|cedil|caron|ring);/g, (m, b, k) =>
        (b + { acute: '\u0301', grave: '\u0300', circ: '\u0302', uml: '\u0308', tilde: '\u0303', cedil: '\u0327', caron: '\u030C', ring: '\u030A' }[k]).normalize('NFC'))
      .replace(/&oslash;/g, '\u00F8').replace(/&Oslash;/g, '\u00D8').replace(/&szlig;/g, '\u00DF')
      .replace(/&aelig;/g, '\u00E6').replace(/&AElig;/g, '\u00C6').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractTables(html) {
    const tables = [];
    const tableRe = /<table[\s\S]*?<\/table>/gi;
    let tm;
    while ((tm = tableRe.exec(html))) {
      const tableHtml = tm[0];
      const rows = [];
      const rowRe = /<tr[\s\S]*?<\/tr>/gi;
      let rm;
      while ((rm = rowRe.exec(tableHtml))) {
        const cells = [];
        const cellRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
        let cm;
        while ((cm = cellRe.exec(rm[0]))) cells.push(stripHtmlTags(cm[1]));
        if (cells.length) rows.push(cells);
      }
      if (rows.length) tables.push(rows);
    }
    return tables;
  }

  // Live-scrape header patterns -- a superset of updates.html's paste
  // patterns, extended for spellings seen across the 45 D1 sites (Sept
  // 2026 survey): bare "Position", "Hgt.", "Handness"/"Handedness", and
  // combined "Hometown / High School" or "Hometown / Previous Team" cells.
  const LIVE_COLUMN_PATTERNS = [
    { key: 'no', re: /^(no\.?|#|num(ber)?|jersey)$/i },
    { key: 'name', re: /^(name|player|full\s*name)$/i },
    { key: 'year', re: /^(yr\.?|cl\.?|class|year|academic\s*year|eligibility|capt\.?)$/i },
    { key: 'pos', re: /^(pos\.?|position)$/i },
    { key: 'ht', re: /^(ht\.?|hgt\.?|height)$/i },
    { key: 'sh', re: /^(sh\.?|s\/c|s\s*\/\s*c|shoots|shoots\/catches|shot\/catch|handness|handedness)$/i },
    { key: 'hs', re: /^(high\s*school|hs|prep\s*school)$/i },
    { key: 'prev', re: /^(previous\.?(\s*(school|team))?|last(\s*(school|team))?|prev\.?(\s*(school|team))?)$/i },
    // Combined cells -- resolved further below by inspecting the header text.
    { key: 'hometownCombined', re: /hometown\s*\/\s*(high\s*school|prep\s*school)/i },
    { key: 'hometownPrevCombined', re: /hometown\s*\/\s*(previous|last)\s*(school|team)/i },
    { key: 'hometown', re: /^hometown$/i },
  ];

  function matchColumns(headerCells) {
    const colMap = {};
    headerCells.forEach((h, i) => {
      const clean = (h || '').trim();
      for (const { key, re } of LIVE_COLUMN_PATTERNS) {
        if (re.test(clean)) {
          // Some pages have BOTH "Previous Team" and "Previous School" columns
          // (Union): keep the first as prev, the second as prev2, so neither is lost.
          if (key === 'prev' && colMap.prev != null) colMap.prev2 = i; else colMap[key] = i;
          break;
        }
      }
    });
    return colMap;
  }

  // Some Sidearm sites (Clarkson 2025-26) split the roster: the visible table
  // has every column EXCEPT the name, and the names live in a separate
  // player list (<li class="sidearm-roster-player">) with the jersey number
  // beside each. Returns { jerseyNumber: 'Full Name' } from that list.
  function namesByJerseyFromPlayerList(html) {
    const out = {};
    const chunks = String(html || '').split(/<li[^>]*class="[^"]*sidearm-roster-player[\s"][^>]*>/i).slice(1);
    for (const c of chunks) {
      const nm = c.match(/aria-label="([^"]+?)\s+-\s+View Profile"/i);
      const jn = c.match(/sidearm-roster-player-jersey-number[^>]*>\s*([^<\s][^<]*?)\s*</i);
      if (!nm || !jn) continue;
      const no = jn[1].trim(), name = stripHtmlTags(nm[1]);
      if (no && !(no in out)) out[no] = name;
    }
    return out;
  }

  // Some sites (Robert Morris) list names "Last, First". Flip to "First Last"
  // so the name and personkey match everything else. Leaves "Smith, Jr." alone.
  function flipLastFirst(n) {
    const t = String(n || '').trim();
    const m = t.match(/^([^,()]+?),\s*([^,]+)$/);
    if (!m || /^(jr|sr|ii|iii|iv)\.?$/i.test(m[2].trim())) return n;
    return m[2].trim() + ' ' + m[1].trim();
  }

  function colMapScore(colMap) {
    // Same bar updates.html uses for a pasted table: need Name plus at
    // least 2 more recognizable columns, or this isn't the roster table
    // (rules out a school's coaching-staff or schedule table on the same
    // page, which have different headers).
    if (colMap.name != null) return Object.keys(colMap).length;
    // Nameless roster table (names are in the page's player list instead):
    // needs the jersey column to pair with, plus position or height, and
    // enough other columns that it can't be a schedule or staff table.
    const n = Object.keys(colMap).length;
    return (colMap.no != null && (colMap.pos != null || colMap.ht != null) && n >= 4) ? n : 0;
  }

  // Splits "Plymouth, MA / Bishop Feehan" into its two halves, the way a
  // combined Hometown/High-School or Hometown/Previous-Team cell needs to
  // be split before parseHometown() can read the region off the first half.
  function splitCombinedCell(raw) {
    const i = raw.search(/\s\/\s/);
    if (i === -1) return { first: raw, second: '' };
    return { first: raw.slice(0, i).trim(), second: raw.slice(i + 3).trim() };
  }

  /* Finds the roster table in a school's live roster page HTML and returns
     {players, issues} in the same shape updates.html's own parser does --
     players: [{name, pk, y, pos, ht, home, st, ctry, no, sh, prevSchool}],
     issues: [string, ...] (name tags, ambiguous nicknames, bad heights,
     unrecognized regions -- same "flag it, don't guess" policy as every
     other entry point into this module). setNameMaps() must already have
     been called (same firstNameMap.json-driven aliasing as everywhere
     else) before this runs. */
  function extractRosterTable(html, opts) {
    opts = opts || {};
    const tables = extractTables(html);
    let best = null, bestScore = 0, bestColMap = null;
    for (const rows of tables) {
      if (!rows.length) continue;
      const colMap = matchColumns(rows[0]);
      const score = colMapScore(colMap);
      if (score > bestScore) { best = rows; bestScore = score; bestColMap = colMap; }
    }
    if (!best) return { players: [], issues: ['Could not find a roster table on the page (need a header row with Name plus at least 2 more recognizable columns).'], fieldsAvailable: [] };

    const colMap = bestColMap;
    const players = [];
    const issues = [];
    const nameByNo = colMap.name == null ? namesByJerseyFromPlayerList(html) : null;
    if (nameByNo && !Object.keys(nameByNo).length) {
      return { players: [], issues: ['The roster table has no Name column and the page has no player list to take names from.'], fieldsAvailable: [] };
    }
    for (let r = 1; r < best.length; r++) {
      const cells = best[r];
      const rawName = flipLastFirst(colMap.name != null ? cells[colMap.name]
        : (nameByNo[cleanCell(colMap.no != null ? cells[colMap.no] : '')] || ''));
      if (!rawName) continue; // a blank/section-divider row
      const nameNoPronounce = stripPronounce(rawName);
      // Unaccent to match the storage convention used everywhere else in
      // colrosters.json (see parseHometown above) -- otherwise a page that
      // renders a player's name with its native diacritics (e.g. "Hesová")
      // shows up as a spurious "name changed" diff against the existing
      // unaccented record ("Hesova") on every single validate run.
      const name = unaccent(stripNameTags(nameNoPronounce)); // store the clean name; the tag is still flagged below
      const pk = applyPkException(makePersonKey(nameNoPronounce), opts.school);

      const y = colMap.year != null ? normalizeYear(cells[colMap.year]) : '';
      const pos = colMap.pos != null ? normalizePos(cells[colMap.pos]) : '';
      const htN = normHeight(colMap.ht != null ? cleanCell(cells[colMap.ht]) : '');
      const no = colMap.no != null ? cleanCell(cells[colMap.no]) : '';
      const sh = colMap.sh != null ? normShoots(cleanCell(cells[colMap.sh])) : '';

      let home = '', st = '', ctry = '', prevSchool = '', hsCell = '';
      if (colMap.hometownCombined != null) {
        const { first, second } = splitCombinedCell(cleanCell(cells[colMap.hometownCombined]));
        const hp = parseHometown(first);
        home = hp.home; st = hp.st; ctry = hp.ctry;
        hsCell = cleanCell(second);
      } else if (colMap.hometownPrevCombined != null) {
        const { first, second } = splitCombinedCell(cleanCell(cells[colMap.hometownPrevCombined]));
        const hp = parseHometown(first);
        home = hp.home; st = hp.st; ctry = hp.ctry;
        prevSchool = cleanCell(second); // 'Town / null' -> blank
      } else if (colMap.hometown != null) {
        const hp = parseHometown(cleanCell(cells[colMap.hometown]));
        home = hp.home; st = hp.st; ctry = hp.ctry;
        prevSchool = hp.prevSchool || prevSchool;
      }
      if (colMap.prev != null) {
        const pa = cleanCell(cells[colMap.prev]);
        const pb = colMap.prev2 != null ? cleanCell(cells[colMap.prev2]) : '';
        prevSchool = (pa && pb) ? pa + ' / ' + pb : (pa || pb || prevSchool);
      }
      if (colMap.hs != null) hsCell = cleanCell(cells[colMap.hs]) || hsCell;
      // colrosters.json's shape has no separate High School field today --
      // fold it into prevSchool only when the page has NO dedicated Previous
      // Team column at all (colMap.prev == null). When a page shows both
      // columns separately, a blank Previous Team for a given player is a
      // real fact (came straight from high school hockey, no separate
      // club/junior team) -- promoting High School into prevSchool in that
      // case would conflate two different fields and produce a false
      // "changed" diff (confirmed on Brown's page: Elodie Roy, Bogi
      // Bahiczki-Toth, Rory Edwards all have a real blank Previous Team
      // alongside a real High School value).
      if (hsCell && !prevSchool && colMap.prev == null && colMap.hometownPrevCombined == null) prevSchool = hsCell;

      const tags = nameTags(rawName);
      if (tags.length) issues.push(`${name}: has a "${tags.join('/')}" tag — ignored for the personkey.`);
      if (htN.issue) issues.push(`${name}: ${htN.issue}`);
      if (ctry === '__UNKNOWN__') issues.push(`${name}: unrecognized state/country "${st}" — check the Hometown cell.`);
      const ambig = computeAmbigIssue(name, pk, false, opts.findHistoricalPksForLastName);
      if (ambig) issues.push(`${name}: ${ambig}`);

      players.push({
        name, pk, y, pos, ht: htN.value,
        home, st: st === '__UNKNOWN__' ? st : st, ctry,
        ...(no ? { no } : {}), ...(sh ? { sh } : {}), ...(prevSchool ? { prevSchool } : {}),
      });
    }
    // Which colrosters.json fields this page's table actually exposes --
    // a past-season archive page often drops columns the current-season
    // page has (e.g. Brown's 2025-26 archive has no Shoots column at all,
    // where the 2026-27 page does). diffRoster needs this to tell "this
    // field is genuinely blank" from "this page doesn't publish this field
    // at all" -- only the latter should be skipped rather than flagged as
    // a change.
    const fieldsAvailable = ['name'];
    if (colMap.no != null) fieldsAvailable.push('no');
    if (colMap.year != null) fieldsAvailable.push('y');
    if (colMap.pos != null) fieldsAvailable.push('pos');
    if (colMap.ht != null) fieldsAvailable.push('ht');
    if (colMap.sh != null) fieldsAvailable.push('sh');
    if (colMap.hometown != null || colMap.hometownCombined != null || colMap.hometownPrevCombined != null) {
      fieldsAvailable.push('home', 'st', 'ctry');
    }
    // NOTE: colMap.hs (a bare "High School" column, with no dedicated
    // Previous Team/School column) is intentionally excluded here even
    // though extractRosterTable() still folds it into prevSchool above via
    // the HS fallback. A high school name is not the same fact as a prior
    // hockey program, and some schools' pages only publish the former --
    // diffing that fallback value against genuine stored prevSchool data
    // (a real club/prep team) produces a false "changed" on every player
    // whose real prior team differs from their high school (e.g. Harvard,
    // which only lists High School + Concentration on its roster page).
    // Only a genuine dedicated column counts as "this page provides
    // prevSchool" for diff purposes.
    if (colMap.prev != null || colMap.hometownPrevCombined != null) {
      fieldsAvailable.push('prevSchool');
    }

    return { players, issues, fieldsAvailable };
  }

  /* =======================================================================
     7. Clean-to-clean diff -- live-scraped-and-cleaned roster vs. the
        colrosters.json entry already on file for that school/season.
        Compares by personkey; any field difference on a matched player
        counts as "changed", per school's choice (Sept 2026): no threshold,
        no ignoring minor fields -- a new player, a departed player, or ANY
        changed field should surface the "update now?" prompt.
     ======================================================================= */
  const DIFF_FIELDS = ['name', 'y', 'pos', 'ht', 'home', 'st', 'ctry', 'no', 'sh', 'prevSchool'];

  function diffRoster(liveRows, existingRows, fieldsAvailable) {
    const byKeyLive = {}; (liveRows || []).forEach(p => { byKeyLive[p.pk] = p; });
    const byKeyExisting = {}; (existingRows || []).forEach(p => { byKeyExisting[p.pk] = p; });
    // Only diff fields the live page actually publishes, when told -- a
    // field the page doesn't expose at all (no column for it) is left out
    // of the comparison entirely, rather than treated as "cleared to blank".
    const compareFields = fieldsAvailable ? DIFF_FIELDS.filter(f => fieldsAvailable.includes(f)) : DIFF_FIELDS;

    const added = [], removed = [], changed = [];
    for (const pk in byKeyLive) {
      if (!(pk in byKeyExisting)) { added.push(byKeyLive[pk]); continue; }
      const a = byKeyLive[pk], b = byKeyExisting[pk];
      const fieldDiffs = compareFields.filter(f => (a[f] || '') !== (b[f] || ''));
      if (fieldDiffs.length) changed.push({ pk, name: a.name, fields: fieldDiffs, live: a, existing: b });
    }
    for (const pk in byKeyExisting) {
      if (!(pk in byKeyLive)) removed.push(byKeyExisting[pk]);
    }
    return {
      added, removed, changed,
      hasChanges: added.length > 0 || removed.length > 0 || changed.length > 0,
    };
  }

  return {
    setNameMaps, applyPkException,
    stripPronounce, unaccent, stripNameTags, nameTags,
    makePersonKey, firstNameWasCanonicalized, splitFirstLast,
    AMBIGUOUS_NICKNAMES, computeAmbigIssue,
    normalizePos, normalizeYear, normHeight,
    cleanCell, parseHometown, normalizeStateAndHometown,
    normCommitted,
    US_STATE_ABBR, CANADA_PROVINCE, COUNTRY_CONTINENT,
    US_FULL_TO_ABBR, CA_FULL_TO_ABBR, REGION_FULL_TO_ABBR, REGION_ABBR_OK, COUNTRY_WORDS,
    stripHtmlTags, extractTables, matchColumns, extractRosterTable,
    diffRoster,
  };
});
