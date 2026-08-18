"""Build v1-migration-map.json. An address must RESOLVE and must be ATTRIBUTABLE.

Two gates, learned in that order:

1. RESOLVE. The first draft emitted 20 defective addresses -- 18 fields that do
   not exist on the category named, and 2 from substring matching
   (tangibleAssets matched nonCurrentAssetIntangibleAssets, the opposite fact).
   So address() refuses anything the registry does not declare.

2. ATTRIBUTE. Resolving is not being right. 38 entries carried a field name
   declared by MORE THAN ONE category, and the fallback silently took whichever
   category appeared first in adapter-categories.json -- putting `companyName`
   on financial-statement and splitting one bank statement across two
   categories while its siblings went to a third. Both were well-formed and
   wrong. So bare name-equality now REFUSES an ambiguous name, and two authored
   bridges are consulted first.

THE KEY LIST IS A UNION, NOT A CAPTURE. `scripts/v1-response-keys.json` is the
union of the response keys over 150 live records, because the v1 serializer
emits a key only where the record HAS the data -- measured 2026-08-18, the
per-record key set ranges 346..662 across 4 distinct shapes. The first version
of this map was generated from ONE captured record, and that is precisely how
it shipped without `consents`: the record used had no consent events, so the
key was never in the input and nothing could report it missing. A single
capture describes a record; only the union describes the surface.

The authored bridges are READ FROM origin/main, never transcribed.
wideColumnFeeders.ts says explicitly: "do not copy them anywhere the tests do
not reach." Deriving on every run means this map inherits those tests instead
of forking a copy of their data.
"""
import csv
import json
import os
import re
import subprocess
from collections import defaultdict
from pathlib import Path

# Paths are inputs, not constants: this runs on a developer machine against a
# finsys-api checkout, a captured v1 response and the SYS-2499 column audit,
# none of which this package contains. Override with env vars, do not edit.
CORE = Path(__file__).resolve().parent.parent
API = Path(os.environ.get('FINSYS_API_REPO', CORE.parent / 'finsys-api'))
V1_KEYS = Path(os.environ.get('V1_RESPONSE_KEYS', CORE / 'scripts' / 'v1-response-keys.json'))
AUDIT = Path(os.environ.get('SYS2499_AUDIT',
                            CORE.parent / 'audits/sys2499/ihs-column-disposition.tsv'))
OUT = Path(os.environ.get('OUT', CORE / 'src/data/v1-migration-map.json'))

for label, path in (('FINSYS_API_REPO', API), ('V1_SAMPLE', V1_KEYS), ('SYS2499_AUDIT', AUDIT)):
    if not path.exists():
        raise SystemExit(f'{label} not found at {path} — set the env var to point at it.')

v1 = json.load(open(V1_KEYS))['data']
cats = json.load(open(CORE / 'src/data/adapter-categories.json'))
cat_list = cats['categories'] if isinstance(cats, dict) and 'categories' in cats else cats

FIELDS_BY_CAT = {c['id']: {f['name'] for f in c.get('fields', [])} for c in cat_list}
LEGACY_BY_CAT = {c['id']: {f['legacyName']: f['name'] for f in c.get('fields', []) if f.get('legacyName')}
                 for c in cat_list}
FACT_BY_CAT = {c['id']: {f['fact']: f['name'] for f in c.get('fields', []) if f.get('fact')}
               for c in cat_list}

owners = defaultdict(list)
by_legacy = {}
for c in cat_list:
    for f in c.get('fields', []):
        owners[f['name']].append(c['id'])
        if f.get('legacyName'):
            by_legacy.setdefault(f['legacyName'], []).append((c['id'], f['name']))
AMBIGUOUS = {k for k, v in owners.items() if len(v) > 1}


def address(category, field, instance_key=None, instance_key_prefix=None):
    """Build an address, or raise. Nothing unresolvable escapes this function."""
    if category not in FIELDS_BY_CAT:
        raise ValueError(f'no such category: {category}')
    if field not in FIELDS_BY_CAT[category]:
        raise ValueError(f'{category} declares no field {field}')
    a = {'category': category, 'field': field}
    if instance_key:
        a['instanceKey'] = instance_key
    if instance_key_prefix:
        a['instanceKeyPrefix'] = instance_key_prefix
    return a


def show(path):
    return subprocess.run(['git', '-C', str(API), 'show', f'origin/main:{path}'],
                          capture_output=True, text=True, check=True).stdout


# ---------------------------------------------------------------- bridge 1:
# form-intake fieldMaps. Read from the ref: the main checkout was 41 commits
# stale and held only the 7 finxtract manifests, which silently reported
# fullName/email/mobilePhoneNo/idNumber as unresolved -- a wrong answer that
# looks exactly like a real finding.
listing = subprocess.run(
    ['git', '-C', str(API), 'ls-tree', '-r', '--name-only', 'origin/main',
     'src/infrastructure/adapters/builtinManifests'],
    capture_output=True, text=True, check=True).stdout.split()
by_form_field = {}
for path in [p for p in listing if p.endswith('manifest.json')]:
    man = json.loads(show(path))
    impl = man.get('implementation') or {}
    if isinstance(impl, dict):
        for e in impl.get('fieldMap', []) or []:
            by_form_field[e['formFieldId']] = (man['category'], e['canonical'], e.get('instanceKey'))
assert 'fullName' in by_form_field, 'manifest source looks stale'

# ---------------------------------------------------------------- bridge 2:
# which document category FEEDS each wide column (wideColumnFeeders.ts), and
# which fact a singleton processor binds it to (wideColumnBindings.ts). The
# first is authoritative for category; the second names the fact when the
# column name diverges per source (ssmCompanyName vs companyName).
feeders_src = show('src/domain/extraction/wideColumnFeeders.ts')
feeders_src = re.sub(r'/\*.*?\*/', '', feeders_src, flags=re.S)
feeders_src = re.sub(r'//[^\n]*', '', feeders_src)

col_lists = {name: re.findall(r'"([^"]+)"', body)
             for name, body in re.findall(r'const (\w+_COLUMNS) = \[(.*?)\] as const', feeders_src, re.S)}
feeder_block = re.search(r'WIDE_COLUMN_FEEDERS = \{(.*?)\n\} as const', feeders_src, re.S).group(1)
feeder_cat_of_col = {}
for entry in re.finditer(r'category:\s*"([^"]+)".*?columns:\s*(\w+_COLUMNS)', feeder_block, re.S):
    cat, listname = entry.group(1), entry.group(2)
    for col in col_lists[listname]:
        feeder_cat_of_col.setdefault(col, []).append(cat)
assert len(feeder_cat_of_col) > 150, f'feeder parse looks wrong: {len(feeder_cat_of_col)} columns'
assert feeder_cat_of_col.get('incorporatedDate') == ['company-profile', 'company-registration'], \
    'incorporatedDate must be the shared two-attestor column'

bindings_src = show('src/domain/extraction/wideColumnBindings.ts')
bindings_src = re.sub(r'/\*.*?\*/', '', bindings_src, flags=re.S)
bindings_src = re.sub(r'//[^\n]*', '', bindings_src)
bind_block = re.search(r'WIDE_COLUMN_BINDINGS = \{(.*?)\n\} as const', bindings_src, re.S).group(1)
fact_of_col = {}
for m in re.finditer(r'(\w+):\s*\{', bind_block):
    key, i, depth = m.group(1), m.end() - 1, 0
    while True:                       # brace-match: columnBySource nests
        if bind_block[i] == '{':
            depth += 1
        elif bind_block[i] == '}':
            depth -= 1
            if depth == 0:
                break
        i += 1
    body = bind_block[m.end():i]
    if 'column:' not in body:
        continue
    fact_of_col.setdefault(re.search(r'column:\s*"([^"]+)"', body).group(1), key)
    override = re.search(r'columnBySource:\s*\{([^}]*)\}', body)
    if override:
        for src_col in re.findall(r'"([^"]+)"', override.group(1)):
            fact_of_col.setdefault(src_col, key)
assert fact_of_col.get('ssmCompanyName') == 'companyName', 'binding parse looks wrong'

PERIOD = re.compile(r'(PriorYear)?T[1-9]$')
feeder_by_base = defaultdict(set)
for col, cs in feeder_cat_of_col.items():
    for c in cs:
        feeder_by_base[PERIOD.sub('', col)].add(c)


def resolve_in_category(cat, base, column):
    """Name the canonical field of `cat` that holds this legacy column."""
    for cand in (LEGACY_BY_CAT[cat].get(base), LEGACY_BY_CAT[cat].get(column),
                 FACT_BY_CAT[cat].get(fact_of_col.get(column, '')),
                 FACT_BY_CAT[cat].get(fact_of_col.get(base, '')),
                 fact_of_col.get(base) if fact_of_col.get(base) in FIELDS_BY_CAT[cat] else None,
                 base if base in FIELDS_BY_CAT[cat] else None):
        if cand and cand in FIELDS_BY_CAT[cat]:
            return cand
    return None


audit = {}
with open(AUDIT) as f:
    for r in csv.DictReader(f, delimiter='\t'):
        audit[r['column']] = (r['disposition'], r['target'])

STRUCTURAL = {
    'fieldProvenance': 'provenance is a per-value envelope in v2; the sidecar map is redundant',
    'documentMetadata': 'document-intake carries pointer metadata as canonical fields',
    'financialStatementInstances': 'v2 exposes these as financial-statement instances',
    'bankStatementInstances': 'v2 exposes these as finxtract-bank-statement instances',
    'epfStatementInstances': 'v2 exposes these as epf-statement instances',
    'payslipInstances': 'v2 exposes these as payslip instances',
    'invoiceInstances': 'no invoice category is declared — SYS-3376',
}

DOC_POINTERS = {
    'bankStatements', 'financialStatements', 'epfStatements', 'payslips', 'ssm', 'form9',
    'ic', 'consentForm', 'myKadOrPassport', 'coreIncomeDoc', 'incomeSupportingDoc',
    'incomeEPF_iakaun', 'photocopyRegistrationCard', 'bankStatementOrSavingPassbook',
    'invoices', 'supplementaryDoc', 'tnbBills',
}

SWEEP = {
    'companyWebsite': ('retired',
                       'no consumer in six repos; absent from the core catalog entirely. The only '
                       'hits are Mudah\'s DEALER account profile, a different context.'),
    'noOfEmployees': ('vocabulary-gap',
                      'wanted as an SME signal (Kain) but 0 of 8,474 rows populated and no canonical '
                      'field of the right kind — subject-company.companySizeCode is a coded BAND, this '
                      'is a raw COUNT. Needs a new employeeCount:number on subject-company.'),
    'tangibleAssets': ('vocabulary-gap',
                       'the OWNING category is known — financial-statement feeds this column through '
                       'financialStatementSpec.wideTableMirror — but it declares no field for it. An '
                       'earlier automated match to nonCurrentAssetIntangibleAssets was a SUBSTRING '
                       'ARTIFACT: intangible assets are the opposite fact. Needs a declared field, not '
                       'a lookup.'),
    'currentAssetCash': ('needs-decision',
                         'eight plausible financial-statement targets (CashAndBankBalances, CashAtBanks, '
                         'CashOnHand, CashAndCashEquivalents, ...) and no exact match. Which the extractor '
                         'populates is a question for the financial-statement owner, not a name lookup.'),
    'idType': ('vocabulary-gap',
               'FIVE consumers — Mudah and WooCommerce submit it, finhero-auto collects it as a typed '
               'dropdown driving idNumber consolidation, FinHub renders it, finsys-client renders it. '
               'Its only canonical match is related-person.relatedPersonIdType, which is the WRONG '
               'PERSON. No correct destination exists.'),
    'clientUserId': ('relocated',
                     'SURFACE: GET /lender/applications/:ihsId, as customerUserId (PARTY_FIELDS). NOT retired: FinHub names it at Show.tsx:2039 as the rollout fallback '
                     '(customerUserId ?? clientUserId) building the Customer Profile link. Dropping the '
                     'finsys-api shim and leaving that fallback silently removes the button — the two '
                     'changes are coupled.'),
    'city': ('retired',
             'the bare key is unused, but the DATA is live: WooCommerce collects it at checkout and '
             'submits it as permanentcity. Retired key is not retired data.'),
    'postcode': ('retired', 'as city — collected and submitted as permanentpostcode.'),
    'countryOfPermanentResident': ('retired',
                                   'Mudah collects it and forwards it as nationality; the bare key is '
                                   'not what reaches finsys.'),
    'lengthOfServiceYear': ('retired',
                            'already dead for display: finsys-client recomputes it from dateJoined '
                            '(ihs_detail.ts:230-247) before rendering, so the API value is never shown.'),
    'lengthOfServiceMonth': ('retired', 'as lengthOfServiceYear — recomputed locally before display.'),
}

# ---------------------------------------------------------------------------
# The 19 the mechanical bridges cannot reach. Each disposition is authored
# against evidence, and every address still goes through address(), so a
# hand-authored mistake is refused exactly like a generated one.
#
# The measurements below are from finsim's 8,475-row corpus (2026-08-18). Read
# them as "what a writer CAN produce", not as production counts: the sim writes
# through the Open API, which admits every column. A 0 is the strong signal —
# not even the harness fills it — and a positive count only proves a writer
# exists somewhere.
HAND = {
    # --- phone family. applicant-contact-form-v1 names these seven as
    # deliberately unmapped "because NO live form collects them". The category
    # still declares contactAreaCode/contactExtension: a category describes the
    # domain, a manifest describes what a form actually asks.
    'mobilePhoneNoAreaCode': ('mapped-pending-build', ('applicant-contact', 'contactAreaCode', 'mobile'),
                              'the instance exists (mobilePhoneNo mints it); no form collects the area code, '
                              'so the field is addressable and permanently empty until one does.'),
    'officePhoneNoAreaCode': ('mapped-pending-build', ('applicant-contact', 'contactAreaCode', 'office'),
                              'as mobilePhoneNoAreaCode — the office instance exists, the area code is uncollected.'),
    'emerContactTelNo1AreaCode': ('mapped-pending-build', ('applicant-contact', 'contactAreaCode', 'emergency'),
                                  'as mobilePhoneNoAreaCode — the emergency instance exists and carries a name '
                                  'and relationship; the area code is uncollected.'),
    'internationalPhoneNo': ('mapped-pending-build', ('applicant-contact', 'contactValue', 'international'),
                             'NO manifest mints an "international" instance — the four are email, mobile, office, '
                             'emergency. The field resolves; the instance has to be created before anything can '
                             'write it. 0 of 8,475 rows populated.'),
    'internationalPhoneNoAreaCode': ('mapped-pending-build', ('applicant-contact', 'contactAreaCode', 'international'),
                                     'as internationalPhoneNo — instance not minted by any manifest.'),
    'internationalExtensionPhoneNo': ('mapped-pending-build', ('applicant-contact', 'contactExtension', 'international'),
                                      'as internationalPhoneNo — instance not minted by any manifest.'),
    'phoneNumber': ('needs-decision', None,
                    'THE FIELD IS KNOWN AND THE INSTANCE IS NOT. applicant-contact.contactValue is the home, but '
                    'this column is unqualified: it is one of the founding columns (InitialMigration, alongside '
                    'fullName/email/idNumber), predating the mobile/office/emergency split, so nothing in the '
                    'schema says which kind of contact point it holds. Assigning an instance key guesses, and a '
                    'wrong guess attests a mobile number as an office one. No live form collects it; finsys-client '
                    'renders it through the GENERIC catalog path (ui.ts:33), which degrades silently rather than '
                    'breaking. Needs a data-shape read against production before an instance key is chosen.'),

    # --- address-type family. applicant-address-form-v1 is explicit: the
    # instance key already says which address a row is, so a per-row type
    # column could only disagree with it. This is supersession, not loss.
    'addressType': ('retired', None,
                    'superseded BY THE INSTANCE KEY, not dropped — an applicant-address row is already keyed by '
                    'which address it is. Collected by no live form; 0 of 8,475 rows populated.'),
    'officeaddressType': ('retired', None, 'as addressType — the instance key carries the discriminator.'),
    'permanentaddressType': ('retired', None, 'as addressType — the instance key carries the discriminator.'),
    'residentialaddressType': ('retired', None, 'as addressType — the instance key carries the discriminator.'),
    'mailingBillingAddressInd': ('needs-decision', None,
                                 'NOT an address property. Its choices are Office / Residence, so it names WHICH '
                                 'address is preferred for mail — a statement about the application, and putting '
                                 'it on an address instance would make that row claim something about its '
                                 'siblings. applicant-address-form-v1 declined it for exactly that reason. It IS '
                                 'collected (personal_loan.json; 30 of 8,475 rows). Candidate home: the '
                                 'application record (GET /lender/applications/:ihsId), which already carries '
                                 'application-level facts — but nothing there owns applicant PREFERENCES yet.'),
    'country': ('retired', None,
                'collected by no live form and 0 of 8,475 rows populated. applicant-address declares '
                'addressCountry for the day a form asks; the prefixed variants (permanentcity, permanentpostcode) '
                'are what real submissions carry.'),

    # --- singles
    'consents': ('relocated', None,
                 'SURFACE: GET /lender/applications/:ihsId. NOT the flat booleans — v1 emits the raw '
                 'consent EVENT ROWS (id, consentDefinitionId, consentDefinitionVersionId, ipAddress, '
                 'method, bindingMessage, createdAt); the application record carries ConsentReference[] '
                 'pointing into the consent engine instead, because copying versioned, snapshotted '
                 'events into a second envelope creates a source of truth that drifts. A SHAPE CHANGE, '
                 'not a move: a consumer reading consent state must follow the reference.'),
    'ssmIncorporatedDate': ('retired', None,
                            'SUPERSEDED BY THE SHARED COLUMN and already dead: SYS-3163 moved the SSM processor '
                            'onto WIDE_COLUMN_BINDINGS.companyIncorporationDate, whose column is incorporatedDate '
                            'with no per-source override, so projectSsmCanonical has not written this column '
                            'since. MEASURED: 839 of 8,475 rows carry ssmCompanyName (the same extractor\'s '
                            'sibling, and the positive control that makes this zero meaningful) and 839 carry '
                            'incorporatedDate, while ZERO carry ssmIncorporatedDate. SEE SYS-3419 FOR THE LIVE DEFECT THIS '
                            'EXPOSES — both UIs still read the dead column.'),
    'bankType': ('retired', None,
                 'varchar(20), and 0 of 8,475 rows. Long mistaken for a document-pointer column (the SYS-2499 '
                 'audit files it under "document file path"), but it cannot be one: the 16 real pointer columns '
                 'hold [{"month":1,"path":"https://..."}] JSON and are text/varchar(1000+). appHelper.ts\'s '
                 'bankTypeList is a lookup table, not a writer.'),
    'salutation': ('vocabulary-gap', None,
                   'the SYS-2499 audit targets applicant-identity, which declares no salutation field — and a '
                   'title is not an identity ATTESTATION, it is a form of address. Collected ONLY by '
                   'personal_loan.json (retired product, which Kain has said could be resurrected) and one '
                   'lead-gen submit script; 0 of 8,475 rows. Needs a declared field before it has an address.'),
    'foreignPR': ('vocabulary-gap', None,
                  'audit targets applicant-identity, which declares no permanent-residency field. Zero on every '
                  'signal: no form, no consumer in six repos, 0 of 8,475 rows. Retire it only if nobody wants '
                  'the FACT — the fact itself is real and a CRA subject model may want it.'),
    'pRIDNo': ('vocabulary-gap', None,
               'as foreignPR — the PR identity number. applicant-identity.personIdNumber attests the primary ID; '
               'a second, differently-issued number needs its own field or an idType-qualified instance, which is '
               'the same gap idType has.'),
    'companyBackground': ('vocabulary-gap', None,
                          'subject-company-form-v1 names it as one of three columns "collected by nothing at all", '
                          'and DELIBERATELY does not declare it — mapping it would mint an applicant attestation '
                          'for a value no applicant gave. 0 of 8,475 rows; the only reference in six repos is a '
                          'lead-gen test submit script. SITS EXACTLY WHERE noOfEmployees DID, which Kain kept as '
                          'an SME signal, so this is a want-it-or-not call rather than an evidence question.'),
}

OBLIGATIONS = {
    'housingLoanMonthlyInstallment': 'housingLoan',
    'hirePurchaseMonthlyInstallment': 'hirePurchase',
    'personalLoanMonthlyInstallment': 'personalLoan',
    'creditCardMonthlyInstallment': 'creditCard',
    'otherFinancingMonthlyInstallment': 'otherFinancing',
}

entries, unresolved, rejected, ambiguous = {}, [], [], []
for key in sorted(v1.keys()):
    base = PERIOD.sub('', key)
    try:
        if key in STRUCTURAL:
            entries[key] = {'disposition': 'structural', 'note': STRUCTURAL[key]}
        elif base in SWEEP:
            disp, reason = SWEEP[base]
            e = {'disposition': disp, 'reason': reason, 'via': 'consumer-sweep'}
            # A relocated key that names no surface is the same defect as a
            # mapped key with no address: it reads as answered and is not.
            if disp == 'relocated':
                e['surface'] = 'GET /lender/applications/:ihsId'
            entries[key] = e
        elif base in OBLIGATIONS:
            entries[key] = {
                'disposition': 'mapped-pending-build', 'via': 'hand-authored',
                'address': address('applicant-obligations', 'obligationMonthlyInstallment',
                                   instance_key=OBLIGATIONS[base]),
                'note': 'CCRIS-sourced, named in the CitaGlobal Angkasa spec and feeding DSR/NDI. '
                        'WooCommerce submits it today from installs we cannot update. The destination '
                        'category has NO TABLE — this is an address, not a live one. Multi-attestor: '
                        'the same obligation may arrive from CTOS, Experian, manual entry or FHD.',
            }
        elif base in HAND:
            disp, addr, note = HAND[base]
            e = {'disposition': disp, 'via': 'hand-authored', 'note': note}
            if disp == 'relocated' and note.startswith('SURFACE: '):
                e['surface'] = note.split('SURFACE: ', 1)[1].split('.')[0]
            if addr:
                e['address'] = address(addr[0], addr[1], instance_key=addr[2])
            entries[key] = e
        elif base in DOC_POINTERS:
            entries[key] = {
                'disposition': 'mapped', 'via': 'hand-authored',
                'address': address('document-intake', 'pathInDms', instance_key_prefix=base),
                'note': 'SHAPE CHANGE, not a rename. The v1 column held a JSON array of paths; '
                        'document-intake keys one instance per file as <docType>#<sha256>, so this '
                        'column becomes N instances.',
            }
        # Document-fed columns: the feeder table names the category, so no
        # name-equality guess is involved and no ambiguity can arise.
        elif key in feeder_cat_of_col or base in feeder_by_base:
            cs = sorted(feeder_cat_of_col[key]) if key in feeder_cat_of_col else sorted(feeder_by_base[base])
            addrs = []
            for cat in cs:
                fld = resolve_in_category(cat, base, key)
                if not fld:
                    raise ValueError(f'{cat} feeds this column but declares no field for {base}')
                addrs.append(address(cat, fld))
            if len(addrs) == 1:
                entries[key] = {'disposition': 'mapped', 'via': 'wide-column-feeder',
                                'address': addrs[0]}
            else:
                entries[key] = {
                    'disposition': 'mapped-fanout', 'via': 'wide-column-feeder', 'addresses': addrs,
                    'note': 'ONE v1 column, TWO attestors. The wide table could hold one value, so the '
                            'second writer overwrote the first; v2 keeps both instances and the '
                            'disagreement is the signal. A consumer reading one address gets one '
                            'attestor\'s answer, not "the" answer.',
                }
        elif base in by_form_field:
            cid, field, ikey = by_form_field[base]
            entries[key] = {'disposition': 'mapped', 'via': 'form-intake-fieldmap',
                            'address': address(cid, field, instance_key=ikey)}
        elif base in by_legacy and len(by_legacy[base]) == 1:
            cid, field = by_legacy[base][0]
            entries[key] = {'disposition': 'mapped', 'via': 'legacy-name',
                            'address': address(cid, field)}
        elif base in owners:
            if base in AMBIGUOUS:
                ambiguous.append((key, owners[base]))
            else:
                entries[key] = {'disposition': 'mapped', 'via': 'name-equality',
                                'address': address(owners[base][0], base)}
        else:
            disp, target = audit.get(base, (None, None))
            if disp == 'NOT-ADAPTER' and target and target.startswith(('facility', 'workflow')):
                entries[key] = {'disposition': 'relocated', 'via': 'column-audit',
                                'surface': 'GET /lender/applications/:ihsId'}
            elif disp == 'NOT-ADAPTER' and target and target.startswith('consent'):
                entries[key] = {'disposition': 'relocated', 'via': 'column-audit',
                                'surface': 'the consent engine'}
            else:
                unresolved.append(key)
    except ValueError as exc:
        rejected.append((key, str(exc)))

print(f'v1 response keys        : {len(v1)}')
print(f'entries emitted         : {len(entries)}')
print(f'REJECTED (bad address)  : {len(rejected)}')
print(f'AMBIGUOUS (refused)     : {len(ambiguous)}')
print(f'still unresolved        : {len(unresolved)}')
by_disp, by_via = defaultdict(int), defaultdict(int)
for e in entries.values():
    by_disp[e['disposition']] += 1
    by_via[e.get('via', '-')] += 1
print()
for d, n in sorted(by_disp.items(), key=lambda x: -x[1]):
    print(f'  {d:<22} {n}')
print()
for v, n in sorted(by_via.items(), key=lambda x: -x[1]):
    print(f'  via {v:<24} {n}')
if rejected:
    print('\nREJECTED:')
    for k, why in rejected[:15]:
        print(f'   {k:<38} {why}')
if ambiguous:
    print(f'\nAMBIGUOUS ({len(ambiguous)}) — name declared by >1 category, refused rather than guessed:')
    for k, cs in ambiguous:
        print(f'   {k:<34} {cs}')
if unresolved:
    print(f'\nUNRESOLVED ({len(unresolved)}):')
    for i in range(0, len(unresolved), 4):
        print('   ' + ', '.join(unresolved[i:i + 4]))

# A partial map reads exactly like a complete one, which is the defect this
# whole file is organised against. Refuse to write one.
if rejected or ambiguous or unresolved:
    raise SystemExit('\nREFUSING TO WRITE: every v1 key needs an authored disposition.')

json.dump({'schemaVersion': '0.3.0-draft', 'entries': entries},
          open(OUT, 'w'), indent=2, sort_keys=True)
print(f'\nwrote {OUT}')
