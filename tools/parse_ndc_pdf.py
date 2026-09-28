#!/usr/bin/env python3
"""
parse_ndc_pdf.py — HockeyFile / TopShelf

Extracts NDC camp roster data straight from a USA Hockey "Program & Scout
Book" PDF (the kind uploaded each summer per camp: U15, U1617, U18, and
each new WNT announcement), instead of hand-transcribing it into the NDC
tab.

Why the bio-card pages, not the simple roster-table pages: the roster
table (NO/NAME/2025-26 TEAM/POSITION/DOB/GRAD YEAR/HT/WT) has everything
except Hometown/State, which only appears on each player's individual bio
card later in the same PDF. So this script reads the bio-card pages.

Usage:
    python3 parse_ndc_pdf.py <path-to-pdf>  > ndc_rows.json

Output: a JSON array of rows shaped like the NDC tab's columns
(YEAR, CAMP, WNT, NAME, TEAM, POSITION, DOB, BIRTHYR, GRAD, HT, WT,
HOMETOWN, STATE, DISTRICT, COUNTRY), ready to run through
tools/rosterClean.js (makePersonKey / computeSwapIssue / checkYearSanity)
before appending to the NDC source data.

What this script does NOT do, on purpose:
  - WNT: not in this PDF at all -- announced separately, later in the
    summer (see the cascade note in memory / hockeyfile-web-app.md). Fill
    in after the fact from that announcement, same as today.
  - PA district: genuinely needs a human call (Pittsburgh vs Philadelphia
    by hometown) -- the script leaves DISTRICT blank for PA rows and
    lists them at the end so nothing silently guesses wrong.
  - Country: defaults every row to US. If a future camp includes a
    non-US hometown or a known dual citizen, that still needs a manual
    override, same as today -- the script does not try to infer it.
  - personkey: deliberately NOT computed here. Run the output through
    rosterClean.js's makePersonKey/computeSwapIssue/checkYearSanity
    (Node) as a separate step, same shared module every other source
    uses -- keeps this script a pure "read the PDF" tool, not another
    place personkey logic could drift out of sync.
"""
import sys
import re
import json

try:
    import pymupdf as fitz  # PyMuPDF -- import under its current name to avoid the "fitz" deprecation warning on stdout
except ImportError:
    print("Run: pip install pymupdf --break-system-packages", file=sys.stderr)
    sys.exit(1)

STATE_DISTRICT = {
    'DE': 'Atlantic', 'NJ': 'Atlantic',
    'NE': 'Central', 'WI': 'Central', 'IA': 'Central', 'KS': 'Central', 'MO': 'Central', 'IL': 'Central',
    'MA': 'Massachusetts',
    'MI': 'Michigan',
    'IN': 'Mid-American', 'KY': 'Mid-American', 'OH': 'Mid-American', 'WV': 'Mid-American',
    'MN': 'Minnesota',
    'CT': 'New England', 'ME': 'New England', 'NH': 'New England', 'RI': 'New England', 'VT': 'New England',
    'NY': 'New York',
    'MT': 'Northern Plains', 'ND': 'Northern Plains', 'SD': 'Northern Plains', 'WY': 'Northern Plains',
    'AK': 'Pacific', 'CA': 'Pacific', 'HI': 'Pacific', 'NV': 'Pacific', 'OR': 'Pacific', 'WA': 'Pacific',
    'AZ': 'Rocky Mountain', 'CO': 'Rocky Mountain', 'ID': 'Rocky Mountain', 'NM': 'Rocky Mountain',
    'OK': 'Rocky Mountain', 'TX': 'Rocky Mountain', 'UT': 'Rocky Mountain',
    'NC': 'Southeastern', 'SC': 'Southeastern', 'MD': 'Southeastern', 'VA': 'Southeastern', 'DC': 'Southeastern',
    'AL': 'Southeastern', 'AR': 'Southeastern', 'GA': 'Southeastern', 'LA': 'Southeastern', 'MS': 'Southeastern',
    'TN': 'Southeastern', 'FL': 'Southeastern',
    'PA': 'TBD',  # always flagged for a manual Pittsburgh-vs-Philadelphia check
}

PLAYER_START_RE = re.compile(r'\n(\d{1,2})\n([A-Z][A-Z\'\.\- ]+)\nPosition:\n')
TITLE_RE = re.compile(r"(\d{4}) USA Hockey Girls National (\d+(?:/\d+)?)")
TEAM_HEADER_RE = re.compile(r'\n([A-Z][A-Z ]+ TEAM)\n')


def normalize_camp(num_str):
    digits = re.sub(r'\D', '', num_str)  # "16/17" -> "1617", "15" -> "15", "18" -> "18"
    return 'U' + digits


def title_case_name(upper_name):
    return ' '.join(w.capitalize() if w.isalpha() else w for w in upper_name.split())


def parse_pdf(path):
    doc = fitz.open(path)

    year, camp = '', ''
    for i in range(doc.page_count):
        m = TITLE_RE.search(doc[i].get_text())
        if m:
            year, camp = m.group(1), normalize_camp(m.group(2))
            break

    bio_pages = {}  # team color -> list of page texts
    for i in range(doc.page_count):
        t = doc[i].get_text()
        if 'Hometown:' in t and 'Position:' in t:
            tm = TEAM_HEADER_RE.search(t)
            team_color = tm.group(1).title() if tm else '?'
            bio_pages.setdefault(team_color, []).append(t)

    rows, issues = [], []

    for team_color, texts in bio_pages.items():
        full = '\n'.join(texts)
        matches = list(PLAYER_START_RE.finditer(full))
        for idx, mm in enumerate(matches):
            name_upper = mm.group(2).strip()
            block_start = mm.end()
            block_end = matches[idx + 1].start() if idx + 1 < len(matches) else len(full)
            block = full[block_start:block_end]

            def grab(label, next_label):
                pat = re.escape(label) + r':\n(.*?)(?=\n' + re.escape(next_label) + r':|\Z)'
                mo = re.search(pat, block, re.DOTALL)
                return mo.group(1).strip() if mo else ''

            pos_m = re.match(r'(.*?)\nClass:', block, re.DOTALL)
            position = pos_m.group(1).strip() if pos_m else ''
            grad = grab('Class', 'GPA')
            dob = grab('DOB', 'Height')
            height = grab('Height', 'Weight')

            team_2025_block = grab('2025-26', '2026-27')
            team = team_2025_block.split('\n')[0].strip()

            hm = re.search(r'Hometown:\n(.*?)\nParent Email', block, re.DOTALL)
            hometown_raw = hm.group(1).strip() if hm else ''
            if ',' in hometown_raw:
                city, state = [x.strip() for x in hometown_raw.rsplit(',', 1)]
            else:
                city, state = hometown_raw, ''
            state = state.upper()

            name = title_case_name(name_upper)
            birthyr = ''
            dob_m = re.search(r'-(\d{4})', dob)
            if dob_m:
                birthyr = dob_m.group(1)

            district = STATE_DISTRICT.get(state, '')
            if state == 'PA':
                issues.append(f'{name}: PA hometown ({city}) — needs manual Pittsburgh-vs-Philadelphia district call')
            elif state and not district:
                issues.append(f'{name}: unrecognized state "{state}" — district lookup failed, check hometown/country')

            rows.append({
                'YEAR': year, 'CAMP': camp, 'WNT': '', 'NAME': name, 'TEAM': team,
                'POSITION': position, 'DOB': dob, 'BIRTHYR': birthyr, 'GRAD': grad,
                'HT': height, 'WT': grab('Weight', 'S/C'),
                'HOMETOWN': city, 'STATE': state, 'DISTRICT': district, 'COUNTRY': 'US',
            })

    return rows, issues


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('Usage: python3 parse_ndc_pdf.py <path-to-pdf>', file=sys.stderr)
        sys.exit(1)
    rows, issues = parse_pdf(sys.argv[1])
    print(json.dumps(rows, indent=2))
    if issues:
        print(f'\n{len(issues)} rows need a manual look:', file=sys.stderr)
        for i in issues:
            print(' - ' + i, file=sys.stderr)
