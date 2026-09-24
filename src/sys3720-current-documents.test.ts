import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import {
  buildDocumentRowsFromView,
  buildFileFieldTablesFromView,
  documentsOfType,
  fieldProvenanceFromView,
  flatRecordFromView,
  instanceRowsFromView,
} from './ihs-processing.js'
import { resolveExtractionStatusFromView } from './extraction-status.js'
import { ExtractionJobStatus } from './extraction.js'
import type { ExtractionJobRecord } from './extraction-status.js'
import { assertAdapterCategory, categorySchemaOf } from './adapter-categories.js'
import type { CanonicalInstance, CanonicalView } from './canonical-view.js'

/**
 * SYS-3720 + SYS-3721 — which documents v2 lists.
 *
 * SYS-3720: a `legacy:T{n}` extraction row was read as "the n-th intake
 * document", and a slot past the intake count became a document of its own.
 * For financial statements a T-slot is not a document number (finsys-api
 * `financialStatementSpec.ts` `slotFor`: a year=1 statement fills T1 and T2,
 * a year=2 statement fills T3 only), so one statement rendered as two.
 *
 * SYS-3721: intake is append-only, so a replaced upload keeps its row and v2
 * listed it beside its replacement. Decided on SYS-3721 (2026-09-23): v2 lists
 * CURRENT documents only.
 *
 * THE SIGNAL, and why it is a timestamp. finsys-api attests the WHOLE pointer
 * column on every save that touches it (`deriveDocumentIntakeInstances` over
 * the saved column value) and upserts each file onto (ihs, adapter,
 * instance_key), overwriting `observed_at`. So every file still in the column
 * carries the newest save's `observedAt`, and a replaced file keeps the older
 * one. Measured on the finsim database 2026-09-23: for every v1 document type,
 * "observedAt is the newest of its type" agreed with "the path is in the
 * current pointer column" on all 6,704 intake rows.
 *
 * The digest block below was captured on 9.4.0 (d54e94b) BEFORE the change,
 * one SHA-256 per (fixture, output). The CONTROL fixtures must not move; each
 * AFFECTED fixture names exactly the outputs that move. Do not regenerate the
 * 9.4.0 digests to make a run pass.
 */

const DMS = 'https://dms.example/dms-general-storage/'
// Fixed instants. Nothing here is compared to a clock; the distance between
// two saves is part of the fixture.
const SAVE_1 = '2026-06-01T06:22:04.416Z'
const SAVE_2 = '2026-06-01T06:22:04.845Z' // < 1s later: the precision the rule needs
const h = (c: string): string => c.repeat(64)

let run = 0
function inst(instanceKey: string, fields: Record<string, unknown>, extra: Partial<CanonicalInstance> = {}): CanonicalInstance {
  run++
  return {
    instanceKey,
    adapterId: 'fixture',
    adapterVersion: 1,
    runId: run,
    observedAt: SAVE_1,
    fields: Object.fromEntries(Object.entries(fields).map(([k, value]) => [k, { value: value as string, confidentiality: 'internal' }])),
    ...extra,
  }
}

/** An intake row as finsys-api writes it: no uploadedAt (no writer records one), observedAt = the save. */
function intake(documentType: string, hash: string, observedAt = SAVE_1): CanonicalInstance {
  return inst(
    `${documentType}#${hash.slice(0, 8)}`,
    { documentType, pathInDms: `${DMS}${hash}` },
    { adapterId: 'document-intake-v1', observedAt },
  )
}

function valuesFor(category: string, seed: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  categorySchemaOf(assertAdapterCategory(category)).fields.forEach((spec, i) => {
    const name = spec.name as string
    if (spec.type === 'number') out[name] = 1000 + seed * 100 + i
    else if (spec.type === 'boolean') out[name] = (seed + i) % 2 === 0
    else out[name] = `${name}-${seed}`
  })
  return out
}

const fs = (key: string, seed: number, extra: Partial<CanonicalInstance> = {}): CanonicalInstance =>
  inst(key, valuesFor('financial-statement', seed), extra)
const bank = (key: string, seed: number, extra: Partial<CanonicalInstance> = {}): CanonicalInstance =>
  inst(key, valuesFor('finxtract-bank-statement', seed), extra)

function view(intakeRows: CanonicalInstance[], rest: Record<string, CanonicalInstance[]>): CanonicalView {
  return {
    ihsId: 3720,
    categories: {
      'document-intake': { cardinality: 'multi', instances: intakeRows },
      ...Object.fromEntries(Object.entries(rest).map(([c, instances]) => [c, { cardinality: 'multi' as const, instances }])),
    },
  }
}

/** Each fixture is rebuilt from scratch so runIds are deterministic per fixture. */
const FIXTURES: Record<string, () => CanonicalView> = {
  // ── CONTROLS: must not move ──
  'control: three bank statements, one save, two extracted': () => {
    run = 0
    return view(
      [intake('bankStatements', h('a')), intake('bankStatements', h('b')), intake('bankStatements', h('c'))],
      { 'finxtract-bank-statement': [bank(`bankStatement:${h('a')}`, 1), bank(`bankStatement:${h('c')}`, 3)] },
    )
  },
  'control: two financial statements, hashed period rows': () => {
    run = 0
    return view(
      [intake('financialStatements', h('d')), intake('financialStatements', h('e'))],
      {
        'financial-statement': [
          fs(`financialStatement:${h('d')}#T1`, 1, { periodPosition: 1, legacySlot: 'T1' }),
          fs(`financialStatement:${h('d')}#T2`, 2, { periodPosition: 2, legacySlot: 'T2' }),
          fs(`financialStatement:${h('e')}#T1`, 3, { periodPosition: 1 }),
          fs(`financialStatement:${h('e')}#T2`, 4, { periodPosition: 2, legacySlot: 'T3' }),
        ],
      },
    )
  },
  'control: bank legacy slots within the intake count': () => {
    run = 0
    return view(
      [intake('bankStatements', h('a')), intake('bankStatements', h('b')), intake('bankStatements', h('c'))],
      { 'finxtract-bank-statement': [bank('legacy:T1', 1), bank('legacy:T2', 2), bank('legacy:T3', 3)] },
    )
  },
  'control: pre-writer subject, bank legacy slots and no intake': () => {
    run = 0
    return view([], { 'finxtract-bank-statement': [bank('legacy:T1', 1), bank('legacy:T2', 2)] })
  },
  'control: pre-writer subject, financial statement legacy:T1 only': () => {
    run = 0
    return view([], { 'financial-statement': [fs('legacy:T1', 1, { periodPosition: 1, legacySlot: 'T1' })] })
  },
  'control: one save written in two UTC offsets is one instant': () => {
    run = 0
    return view(
      [intake('bankStatements', h('a'), '2026-06-01T14:22:04.416+08:00'), intake('bankStatements', h('b'), SAVE_1)],
      { 'finxtract-bank-statement': [bank(`bankStatement:${h('a')}`, 1)] },
    )
  },
  'control: an intake row with no observedAt leaves its type unfiltered': () => {
    run = 0
    const undated = intake('bankStatements', h('a'))
    delete undated.observedAt
    return view([undated, intake('bankStatements', h('b'), SAVE_2)], {})
  },
  // ── AFFECTED ──
  'SYS-3720: year=1 statement, one upload, legacy:T1 + legacy:T2': () => {
    run = 0
    return view([intake('financialStatements', h('d'))], {
      'financial-statement': [
        fs('legacy:T1', 1, { periodPosition: 1, legacySlot: 'T1' }),
        fs('legacy:T2', 2, { periodPosition: 2, legacySlot: 'T2' }),
      ],
    })
  },
  'SYS-3720: year=2 statement, one upload, legacy:T3 only': () => {
    run = 0
    return view([intake('financialStatements', h('d'))], {
      'financial-statement': [fs('legacy:T3', 3, { periodPosition: 2, legacySlot: 'T3' })],
    })
  },
  'SYS-3720: two uploads, legacy:T1 + T2 + T3': () => {
    run = 0
    return view([intake('financialStatements', h('d')), intake('financialStatements', h('e'))], {
      'financial-statement': [
        fs('legacy:T1', 1, { periodPosition: 1, legacySlot: 'T1' }),
        fs('legacy:T2', 2, { periodPosition: 2, legacySlot: 'T2' }),
        fs('legacy:T3', 3, { periodPosition: 2, legacySlot: 'T3' }),
      ],
    })
  },
  'SYS-3720: pre-writer subject, legacy:T1 + legacy:T2 and no intake': () => {
    run = 0
    return view([], {
      'financial-statement': [
        fs('legacy:T1', 1, { periodPosition: 1, legacySlot: 'T1' }),
        fs('legacy:T2', 2, { periodPosition: 2, legacySlot: 'T2' }),
      ],
    })
  },
  'SYS-3720: bank legacy slot past the intake count': () => {
    run = 0
    return view(
      [intake('bankStatements', h('a')), intake('bankStatements', h('b'))],
      { 'finxtract-bank-statement': [bank('legacy:T1', 1), bank('legacy:T3', 3)] },
    )
  },
  'SYS-3721: financial statement replaced': () => {
    run = 0
    return view(
      [intake('financialStatements', h('a'), SAVE_1), intake('financialStatements', h('b'), SAVE_2)],
      {
        'financial-statement': [
          fs(`financialStatement:${h('b')}#T1`, 1, { periodPosition: 1, legacySlot: 'T1' }),
          fs(`financialStatement:${h('b')}#T2`, 2, { periodPosition: 2, legacySlot: 'T2' }),
        ],
      },
    )
  },
  'SYS-3721: first of three bank statements replaced': () => {
    run = 0
    // Save 1 attested a, b, c. Save 2 replaced a with d: the column is now
    // [d, b, c], so b and c were re-attested at SAVE_2 and a was not.
    return view(
      [
        intake('bankStatements', h('a'), SAVE_1),
        intake('bankStatements', h('b'), SAVE_2),
        intake('bankStatements', h('c'), SAVE_2),
        intake('bankStatements', h('d'), SAVE_2),
      ],
      {
        'finxtract-bank-statement': [
          bank(`bankStatement:${h('b')}`, 2),
          bank(`bankStatement:${h('c')}`, 3),
          bank(`bankStatement:${h('d')}`, 4),
        ],
      },
    )
  },
  'SYS-3721: replaced statement whose extraction was not purged': () => {
    run = 0
    return view(
      [intake('bankStatements', h('a'), SAVE_1), intake('bankStatements', h('b'), SAVE_2)],
      { 'finxtract-bank-statement': [bank(`bankStatement:${h('a')}`, 1), bank(`bankStatement:${h('b')}`, 2)] },
    )
  },
}

const JOBS: ExtractionJobRecord[] = [
  { fileType: 'bankStatements', status: ExtractionJobStatus.Succeeded },
  { fileType: 'bankStatements', status: ExtractionJobStatus.Failed, errorMessage: 'second' },
  { fileType: 'bankStatements', status: ExtractionJobStatus.Processing },
  { fileType: 'financialStatements', status: ExtractionJobStatus.Succeeded },
]

/**
 * Fields a category gained after the 9.4.0 capture, per document type. Each one
 * raises that type's `totalColumns` (the registry denominator) in EVERY
 * fixture — a declared change, not a shape move — so the status output is
 * digested as 9.4.0's registry would have counted it, and every other byte of
 * it is still pinned.
 */
const FIELDS_ADDED_SINCE_9_4_0: Record<string, string[]> = {
  // 9.6.0, SYS-3728: where the statement's currency came from.
  managementAccounts: ['mgmtCurrencySource'],
}
function statusAsAt940(r: ReturnType<typeof resolveExtractionStatusFromView>): unknown {
  return {
    ...r,
    documents: r.documents.map((d) => {
      const added = FIELDS_ADDED_SINCE_9_4_0[d.fileType]
      return added ? { ...d, totalColumns: d.totalColumns - added.length } : d
    }),
  }
}

function outputs(v: CanonicalView): Record<string, unknown> {
  const intakeRows = v.categories['document-intake']!.instances
  return {
    documentsOfType: ['bankStatements', 'financialStatements'].map((t) => documentsOfType(v, intakeRows, t)),
    buildDocumentRowsFromView: buildDocumentRowsFromView(v),
    resolveExtractionStatusFromView: statusAsAt940(resolveExtractionStatusFromView(v, JOBS)),
    instanceRowsFromView: ['financial-statement', 'finxtract-bank-statement'].map((c) => instanceRowsFromView(v, assertAdapterCategory(c))),
    buildFileFieldTablesFromView: buildFileFieldTablesFromView(v),
    fieldProvenanceFromView: fieldProvenanceFromView(v),
    flatRecordFromView: flatRecordFromView(v),
  }
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
function allDigests(): Record<string, Record<string, string>> {
  return Object.fromEntries(
    Object.entries(FIXTURES).map(([name, make]) => [
      name,
      Object.fromEntries(Object.entries(outputs(make())).map(([k, o]) => [k, sha256(JSON.stringify(o))])),
    ]),
  )
}

// Captured on 9.4.0 (d54e94b), before any SYS-3720/3721 change.
const DIGESTS_AT_9_4_0: Record<string, Record<string, string>> = {
  'control: three bank statements, one save, two extracted': {
    'documentsOfType': 'bfa12f077031d0fe9059168a74dc293f07467dab606ad90a3da7cdecfa65e7c3',
    'buildDocumentRowsFromView': '7838bbb1a90f00d5477ad37fcd12f966abfcb906a0e13e3d7f8399346b127356',
    'resolveExtractionStatusFromView': 'fb8a6ea910060d7d5e5fa89776d42f914e4e6f2aa2d930c344a594842fd9d52a',
    'instanceRowsFromView': 'f0127ad4688e954d69eae117f6fb1c0a4a22693c2ecbeb0c72ea4ea140a3aed7',
    'buildFileFieldTablesFromView': '96e45e8c1aa8c32333103f704c35141ae8cde5408d9fcbb660da232d61a17ca7',
    'fieldProvenanceFromView': '8b0882a899489da8161858677e858ebc776e419b4d72bcf615792dc47f0e9492',
    'flatRecordFromView': '62a1aa45fa550e36d165592e3564a0a5eec0243d70f1ca9d28cbba607db61aaa'
  },
  'control: two financial statements, hashed period rows': {
    'documentsOfType': 'b2add53886de5d95f38a7f87125bd795a94a11570baae58ce3bfdbc0611f7385',
    'buildDocumentRowsFromView': '81b752cb198b50463ce3cce654de505bca3e3f984cb6db1b005c090e4b828890',
    'resolveExtractionStatusFromView': '02700fc64e4fa93f012380861143d398266d4ea6c105a10ff9f96fdfcf67b818',
    'instanceRowsFromView': '0b2a0ab5638f4aa2a32aa70f5af927a1cc17784e93a52bd62b88a5f347545762',
    'buildFileFieldTablesFromView': 'c101a14545a8b550f35c6dcb50afbc943ac860b0dc38959c6db87decf9564767',
    'fieldProvenanceFromView': '8b0882a899489da8161858677e858ebc776e419b4d72bcf615792dc47f0e9492',
    'flatRecordFromView': '0e5009b0dfa99b7644476fee6c893d654f88191859940cd5022a1915957cc42f'
  },
  'control: bank legacy slots within the intake count': {
    'documentsOfType': 'cf9ef34dca914346da99b37fa454ee253f5f3bbaa8514820659425ae84b1991e',
    'buildDocumentRowsFromView': '7838bbb1a90f00d5477ad37fcd12f966abfcb906a0e13e3d7f8399346b127356',
    'resolveExtractionStatusFromView': '2931a48598adf6f45feaff57fd358d00da248b06e6c805d07e331366a10fa6f4',
    'instanceRowsFromView': '559db8b64e790d2f7ea57a3e8d6e30e173503ab7571d147215f66e909c9267dd',
    'buildFileFieldTablesFromView': '15ccd6d6b7202f85aff16495f035be4dace80c6ddb06410c1c622d2b4d1ff74e',
    'fieldProvenanceFromView': '8b0882a899489da8161858677e858ebc776e419b4d72bcf615792dc47f0e9492',
    'flatRecordFromView': '6a82f935483855870bc4ee2f15fced15b9add1df4aaeb36e28edd20ae07ec84f'
  },
  'control: pre-writer subject, bank legacy slots and no intake': {
    'documentsOfType': 'e23fa222f58ee438b146f717cf2234bfa5e00a93477371547aee680335d869c9',
    'buildDocumentRowsFromView': 'f9b39078a7faf81dc9db07eeacf234d41363509c0820678532931b5864a835fe',
    'resolveExtractionStatusFromView': 'b95328df51b6e8c7260c49f31e407978ad8b3c777ac4ccbe013286f808dfb485',
    'instanceRowsFromView': 'a24a9bce452376fa100c90cb3470561f662561db929ae4915bd25c8265ab494a',
    'buildFileFieldTablesFromView': 'ea2f3b63fe78f7b4811fa9b064b1ed237532638f3def455defa6156cd066690a',
    'fieldProvenanceFromView': '8b0882a899489da8161858677e858ebc776e419b4d72bcf615792dc47f0e9492',
    'flatRecordFromView': '0e0ace7c797f7ca2e2ab3aa2e0e40261f1517e523adb19ca39f5a4d9be3898b4'
  },
  'control: pre-writer subject, financial statement legacy:T1 only': {
    'documentsOfType': '8952e35304baa972951850e0e3596c886a96f3960f99a84ea92f10a0ad921a67',
    'buildDocumentRowsFromView': 'd0b562fbd8c2bae094db2fe3033d135e977b8fdb85697c01bfe1ce7dd768ff7c',
    'resolveExtractionStatusFromView': 'da55d2fa9cd42262b2b3114f35be04b8652a8cae8b4a3d6daf07394f13b406bf',
    'instanceRowsFromView': 'c15800951af535f38c6ad531d2617a43a260f6d6cb46219f4fd43a5511322476',
    'buildFileFieldTablesFromView': 'a3e673ff47c2d8fa07d5c4624d063d100eac9cd94f9d4958dc861b1c114f93a1',
    'fieldProvenanceFromView': '8b0882a899489da8161858677e858ebc776e419b4d72bcf615792dc47f0e9492',
    'flatRecordFromView': '80bbdc750b3f428cf9433854f7a7573512b6019a48d087a0e498c934ab017f2e'
  },
  'control: one save written in two UTC offsets is one instant': {
    'documentsOfType': 'd76c7ec6d9ab077f5b11a36316468cd149fe9c14683dba5009bae7d47f65aeb9',
    'buildDocumentRowsFromView': '31a4a088831882fba4871727d838aa63df62a26f0fc6ce4674ab7ce135a39225',
    'resolveExtractionStatusFromView': '986e9c9590b99a8444cb49331ef1226bf189e8ce584a11220a625001a3323aa1',
    'instanceRowsFromView': '7838ae0009b510450bb9e46b061dddf405ae876652014b0655ac928625749f9a',
    'buildFileFieldTablesFromView': '27b83452b3fbbec2828b6c7fb01ba30117383311573a13a90ff0674a524c62b0',
    'fieldProvenanceFromView': '8b0882a899489da8161858677e858ebc776e419b4d72bcf615792dc47f0e9492',
    'flatRecordFromView': 'e5d5a7399faeee58bb9aabdbafe3ee2cf839d617351c3ba67877526c9e307bfc'
  },
  'control: an intake row with no observedAt leaves its type unfiltered': {
    'documentsOfType': '4ccc3a00cef765b5d6dc71a2a93bb14728529b544660e243f173477c05567e9c',
    'buildDocumentRowsFromView': 'f9b1ac78ec45e8917be7b29ffe0754edf28aa46c1eb840221d4a859571a13bcb',
    'resolveExtractionStatusFromView': '481d3f614507e751535dcf3899dfafaa79a78690fea3e3f8161a063ef1f47014',
    'instanceRowsFromView': '643d5437104296e21d906ecb15b2c96ad278f20cfc4af53b12bb6069bd853726',
    'buildFileFieldTablesFromView': '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    'fieldProvenanceFromView': '8b0882a899489da8161858677e858ebc776e419b4d72bcf615792dc47f0e9492',
    'flatRecordFromView': 'ba67ece3a97e94daa3f661af48aaaf11c68d17b76323dcd0d79c5c1878c18ffb'
  },
  'SYS-3720: year=1 statement, one upload, legacy:T1 + legacy:T2': {
    'documentsOfType': '2672356aadb27235f2586ed840b5cd0c381c215a0c6e4cbf67f73ac2197dbde3',
    'buildDocumentRowsFromView': '5f443676727136004d2d6023e88e47f66bed8dfb3af9c67688c776e904a93ef0',
    'resolveExtractionStatusFromView': '80ba609cafe8d50a3257700c3e5877b8d0fa83b4ee790f4a4f61641a7ac4752b',
    'instanceRowsFromView': 'f281c777438fab0556dee5f18ee2ecb79d13e755ee755313426fa100b208d521',
    'buildFileFieldTablesFromView': '44fe271c97f21582a2232c9d86e89deef659ccb0234e41cef431739225381bee',
    'fieldProvenanceFromView': '8b0882a899489da8161858677e858ebc776e419b4d72bcf615792dc47f0e9492',
    'flatRecordFromView': '42b6f971197f7f3eea019890577f937ac1641a762455a3702897a844e46f10d7'
  },
  'SYS-3720: year=2 statement, one upload, legacy:T3 only': {
    'documentsOfType': 'b2238127c2deee9959831ae7e40dcf77ec3e0c806e37569e8c5d1651023f3dce',
    'buildDocumentRowsFromView': '5f443676727136004d2d6023e88e47f66bed8dfb3af9c67688c776e904a93ef0',
    'resolveExtractionStatusFromView': '83ce659c263cc687c40552482df72821727a530d1a15f05b188545a6baa46363',
    'instanceRowsFromView': '80f0d69ffd7df05fc60973abe339b028a0ee9b7ec28000d960bd6235005e6821',
    'buildFileFieldTablesFromView': '1a4c375b0c6c084553362bcb5d743c4534cf278d518877750c9677851d282c4c',
    'fieldProvenanceFromView': '8b0882a899489da8161858677e858ebc776e419b4d72bcf615792dc47f0e9492',
    'flatRecordFromView': '900c9d3c1b7ab9e1b9e4ab2ecb52a87c5356b33d66fbee600b6c2c76ea01c04a'
  },
  'SYS-3720: two uploads, legacy:T1 + T2 + T3': {
    'documentsOfType': '06a7255c95a10d2d82e3986b8a86c3fff43d781b037e7e30bdecc0528e176091',
    'buildDocumentRowsFromView': 'cac252daa8fa615e6fe1f54305076815fc69f85386f403762852e1a363a2ce5f',
    'resolveExtractionStatusFromView': 'b8ac18a23313be8f5b6a0d42fb125b90c2901f03cf8c86f10f744ca67fffd7f6',
    'instanceRowsFromView': '5d882f477ef0dc4d7c16a9fa888a73d69ee5a064303a920a305310d5aebd8754',
    'buildFileFieldTablesFromView': '8942812c53f109b4060eea7adbfde823a9f01624e76114b1f6fa84c3e61f6883',
    'fieldProvenanceFromView': '8b0882a899489da8161858677e858ebc776e419b4d72bcf615792dc47f0e9492',
    'flatRecordFromView': 'dbfee16eb58ee2d3d0760d440609ba6c225f5e74030579c30ee735530ebe2338'
  },
  'SYS-3720: pre-writer subject, legacy:T1 + legacy:T2 and no intake': {
    'documentsOfType': '1702609867d1f1c0ec2cd5a870d8139452c5cfbf02c5fcdbb766d911f6ceb1d7',
    'buildDocumentRowsFromView': '647586b47641a5893d4435bed9512732013b4f584ff49336046191956a3f6b07',
    'resolveExtractionStatusFromView': '989223b1fa300f817cc3d575161ad25fcb4a624824e6765b3be81ae2031e6517',
    'instanceRowsFromView': 'f281c777438fab0556dee5f18ee2ecb79d13e755ee755313426fa100b208d521',
    'buildFileFieldTablesFromView': '44fe271c97f21582a2232c9d86e89deef659ccb0234e41cef431739225381bee',
    'fieldProvenanceFromView': '8b0882a899489da8161858677e858ebc776e419b4d72bcf615792dc47f0e9492',
    'flatRecordFromView': 'c826aef1653c0b7648d498ab6bb3cf2c9172787b55a388072aa02acba1a80b4d'
  },
  'SYS-3720: bank legacy slot past the intake count': {
    'documentsOfType': 'bd2da467eaecdae4e59d2c8551f288b6fcd467fe273eb2dfab2f1fb57a26e615',
    'buildDocumentRowsFromView': 'd768764a34316dbac101fcc2b919aac6d70ed459a12dac6b41496e92a1a2d929',
    'resolveExtractionStatusFromView': 'dfa0ef71c5391a2114abdc31d60a0f31d7bc18261f7789f71ee4878733107757',
    'instanceRowsFromView': '6507715fdafa132587722a825a9b1fd2d2be63372f359052cb77220e1fe96cbf',
    'buildFileFieldTablesFromView': '96e45e8c1aa8c32333103f704c35141ae8cde5408d9fcbb660da232d61a17ca7',
    'fieldProvenanceFromView': '8b0882a899489da8161858677e858ebc776e419b4d72bcf615792dc47f0e9492',
    'flatRecordFromView': '6fe7cf34f96f489e011d6aac7c0668aef02b868934a5dbc75a19de352fdbd6e8'
  },
  'SYS-3721: financial statement replaced': {
    'documentsOfType': '33c8016d19fe01ef1175fbb08fd37c90f1a10303b79dfa27b0bf2617d6b0d86a',
    'buildDocumentRowsFromView': '5bdea5f051524f5f032ee4326d761ddc01c245edde8a2ee979e5c12da01855a8',
    'resolveExtractionStatusFromView': '4a207fcebd7ded5c128a678b733b3ff196293dc66168abbc44c56c44ecaf1862',
    'instanceRowsFromView': '9050fe3fc6e6cdf49af9149c772a6d33ceb9719604998d18c42149cab9250a6f',
    'buildFileFieldTablesFromView': '44fe271c97f21582a2232c9d86e89deef659ccb0234e41cef431739225381bee',
    'fieldProvenanceFromView': '8b0882a899489da8161858677e858ebc776e419b4d72bcf615792dc47f0e9492',
    'flatRecordFromView': '1b80b28ec66675a142e34c5567c3894dd1d53da7099e136e9c34667720df3259'
  },
  'SYS-3721: first of three bank statements replaced': {
    'documentsOfType': '98bc8aa8b2e330ed48924b9f07376275dcc49d0763c37697a34323bddc7b23f9',
    'buildDocumentRowsFromView': 'c6080248dbdc81f241f823394f6e1a10c37cb021a589a216a13804f0a42ca629',
    'resolveExtractionStatusFromView': '7c130b78a067d40ca41a684c7e9ed43b396032bd4eb4b4cbd12380b27709f388',
    'instanceRowsFromView': 'd2896f095f7ac5982ec30e34fda40d7cb9eb1e0cf03e576d08d879b122b99726',
    'buildFileFieldTablesFromView': '283b2adcad62e84fdc6a45fa33c4715124b22265fbf54f50b87524d5bbdfc8e0',
    'fieldProvenanceFromView': '8b0882a899489da8161858677e858ebc776e419b4d72bcf615792dc47f0e9492',
    'flatRecordFromView': '9d95588714354fda0c561ff7941bf03b32e59edbe2ea9ab26461cf18b36ce348'
  },
  'SYS-3721: replaced statement whose extraction was not purged': {
    'documentsOfType': '5dbfb516fd981387803b02ca3247a3ca99b3ec56aef500b0d821a8bea9f9439b',
    'buildDocumentRowsFromView': '8acf853887b49280dd8ac08d56e81bfa04cf2d77f056622ff6946a81fbe8d911',
    'resolveExtractionStatusFromView': '35f219fbab59b9b4f0f86aaf8fb3f816aa512337ca82649d12f323ae8ea9c77d',
    'instanceRowsFromView': '2947113c735cf99e50e5920cb202d0159553206eee45767a7aed03d22bb8dd62',
    'buildFileFieldTablesFromView': 'ea2f3b63fe78f7b4811fa9b064b1ed237532638f3def455defa6156cd066690a',
    'fieldProvenanceFromView': '8b0882a899489da8161858677e858ebc776e419b4d72bcf615792dc47f0e9492',
    'flatRecordFromView': '58a25aa9ba6de3e07eefdb368c0cde019dad1232fa12045fca2a1616f03b469f'
  }
}

/**
 * The outputs each AFFECTED fixture moves, and why. Any fixture not listed
 * here is a control and must not move at all.
 */
const SHAPE_ONLY = ['documentsOfType', 'buildDocumentRowsFromView', 'resolveExtractionStatusFromView']
const MOVES: Record<string, { outputs: string[]; why: string }> = {
  'SYS-3720: year=1 statement, one upload, legacy:T1 + legacy:T2': { outputs: SHAPE_ONLY, why: 'two statements become one' },
  'SYS-3720: year=2 statement, one upload, legacy:T3 only': { outputs: SHAPE_ONLY, why: 'a phantom extracted statement is gone; the upload is extracted' },
  'SYS-3720: two uploads, legacy:T1 + T2 + T3': { outputs: SHAPE_ONLY, why: 'T2 joins the first statement, T3 the second; no third' },
  'SYS-3720: pre-writer subject, legacy:T1 + legacy:T2 and no intake': { outputs: SHAPE_ONLY, why: 'one statement, not two' },
  'SYS-3720: bank legacy slot past the intake count': { outputs: SHAPE_ONLY, why: 'the slot no longer becomes a document' },
  // flatRecordFromView too: its v1 `financialStatements` pointer array now
  // holds the current file only, as finsys-api's own v1 response does.
  'SYS-3721: financial statement replaced': { outputs: [...SHAPE_ONLY, 'flatRecordFromView'], why: 'the replaced upload is not listed, and not in the v1 pointer array' },
  // Bank rows with no period of their own are labelled by list position
  // (timePeriodOf rule 4), so removing the replaced file from the list moves
  // the current files' labels to where v1 put them: T1..T3, not T2..T4.
  'SYS-3721: first of three bank statements replaced': {
    outputs: [...SHAPE_ONLY, 'instanceRowsFromView', 'buildFileFieldTablesFromView', 'flatRecordFromView'],
    why: 'the replaced file is not listed nor in the v1 pointer array, and the files after it move up one position',
  },
  'SYS-3721: replaced statement whose extraction was not purged': {
    outputs: [...SHAPE_ONLY, 'instanceRowsFromView', 'buildFileFieldTablesFromView', 'flatRecordFromView'],
    why: 'the replaced file and its extraction are not listed; its surviving row has no list position, so no derived period',
  },
}

describe('SYS-3720/3721 — only the affected shapes move from 9.4.0', () => {
  const now = allDigests()
  for (const [name, before] of Object.entries(DIGESTS_AT_9_4_0)) {
    const moves = MOVES[name]?.outputs ?? []
    it(`${name}: ${moves.length === 0 ? 'unchanged' : `moves ${moves.join(', ')}`}`, () => {
      const moved = Object.keys(before).filter((k) => before[k] !== now[name]![k])
      expect(moved).toEqual(moves)
    })
  }
  it('every fixture was captured, and every listed move names a fixture', () => {
    expect(Object.keys(now).sort()).toEqual(Object.keys(DIGESTS_AT_9_4_0).sort())
    for (const name of Object.keys(MOVES)) expect(DIGESTS_AT_9_4_0).toHaveProperty([name])
  })
})

const docs = (name: string, type: string) => {
  const v = FIXTURES[name]!()
  return documentsOfType(v, v.categories['document-intake']!.instances, type)
}
const status = (name: string, type: string, jobs: ExtractionJobRecord[] = []) =>
  resolveExtractionStatusFromView(FIXTURES[name]!(), jobs).documents.filter((d) => d.fileType === type)
const rows = (name: string, type: string) => buildDocumentRowsFromView(FIXTURES[name]!()).filter((r) => r.docType === type)

describe('SYS-3720 — a legacy slot never becomes a document when intake has documents of its type', () => {
  it('year=1, one upload, legacy:T1 + T2: one statement, holding both periods', () => {
    const d = docs('SYS-3720: year=1 statement, one upload, legacy:T1 + legacy:T2', 'financialStatements')
    expect(d.map((x) => [x.hash, x.origin, x.extraction.map((e) => e.instanceKey)])).toEqual([
      [h('d'), 'intake', ['legacy:T1', 'legacy:T2']],
    ])
    expect(rows('SYS-3720: year=1 statement, one upload, legacy:T1 + legacy:T2', 'financialStatements')).toHaveLength(1)
    expect(status('SYS-3720: year=1 statement, one upload, legacy:T1 + legacy:T2', 'financialStatements').map((s) => s.status)).toEqual(['extracted'])
  })

  it('year=2, one upload, legacy:T3 only: the upload IS the extracted statement (decided)', () => {
    const name = 'SYS-3720: year=2 statement, one upload, legacy:T3 only'
    expect(docs(name, 'financialStatements').map((x) => [x.hash, x.origin, x.extraction.map((e) => e.instanceKey)])).toEqual([
      [h('d'), 'intake', ['legacy:T3']],
    ])
    const s = status(name, 'financialStatements')
    expect(s.map((x) => [x.status, x.documentId, x.unlinked])).toEqual([['extracted', h('d'), undefined]])
  })

  it('two uploads, legacy:T1 + T2 + T3: T1/T2 are the first statement, T3 the second', () => {
    const d = docs('SYS-3720: two uploads, legacy:T1 + T2 + T3', 'financialStatements')
    expect(d.map((x) => [x.hash, x.extraction.map((e) => e.instanceKey)])).toEqual([
      [h('d'), ['legacy:T1', 'legacy:T2']],
      [h('e'), ['legacy:T3']],
    ])
  })

  it('one upload with T1 + T2 + T3: every slot lands on the one statement, none is dropped or listed', () => {
    // A second statement that was since removed left its T3 behind. With one
    // upload there is one statement to hold it.
    run = 0
    const v = view([intake('financialStatements', h('d'))], {
      'financial-statement': [fs('legacy:T1', 1), fs('legacy:T2', 2), fs('legacy:T3', 3)],
    })
    const d = documentsOfType(v, v.categories['document-intake']!.instances, 'financialStatements')
    expect(d.map((x) => [x.hash, x.extraction.map((e) => e.instanceKey)])).toEqual([[h('d'), ['legacy:T1', 'legacy:T2', 'legacy:T3']]])
  })

  it('the legacy rows still render in the field tables, each under its own period and coordinate (895 and 922 shapes)', () => {
    const cases: Array<[string, Array<[string, string, number]>, string[]]> = [
      ['SYS-3720: year=1 statement, one upload, legacy:T1 + legacy:T2', [['legacy:T1', 'T1', 1], ['legacy:T2', 'T2', 2]], ['T1', 'T2']],
      ['SYS-3720: year=2 statement, one upload, legacy:T3 only', [['legacy:T3', 'T3', 2]], ['T3']],
    ]
    for (const [name, expectedRows, periods] of cases) {
      const v = FIXTURES[name]!()
      const r = instanceRowsFromView(v, 'financial-statement')
      expect(r.map((x) => [x.instanceKey, x.timePeriod, x.periodPosition])).toEqual(expectedRows)
      const table = buildFileFieldTablesFromView(v).financials
      expect(table?.hasData).toBe(true)
      const items = table!.items as Array<{ timePeriods: string[] }>
      expect(items.length).toBeGreaterThan(10)
      for (const item of items) expect(item.timePeriods).toEqual(periods)
    }
  })

  it('no intake: T1 + T2 describe ONE pre-writer statement', () => {
    const d = docs('SYS-3720: pre-writer subject, legacy:T1 + legacy:T2 and no intake', 'financialStatements')
    expect(d.map((x) => [x.hash, x.origin, x.extraction.length])).toEqual([[null, 'extraction-only', 2]])
  })

  it('bank: a slot past the intake count is not a document; a slot within it still attaches', () => {
    const d = docs('SYS-3720: bank legacy slot past the intake count', 'bankStatements')
    expect(d.map((x) => [x.hash, x.extraction.map((e) => e.instanceKey)])).toEqual([
      [h('a'), ['legacy:T1']],
      [h('b'), []],
    ])
    // The slot's rows are not lost: the field table still places them by the slot the key names.
    const tableRows = instanceRowsFromView(FIXTURES['SYS-3720: bank legacy slot past the intake count']!(), 'finxtract-bank-statement')
    expect(tableRows.map((r) => r.timePeriod)).toEqual(['T1', 'T3'])
  })
})

describe('SYS-3721 — v2 lists current documents only', () => {
  it('a replaced financial statement is not listed, counted, or given a row', () => {
    const name = 'SYS-3721: financial statement replaced'
    expect(docs(name, 'financialStatements').map((x) => x.hash)).toEqual([h('b')])
    expect(rows(name, 'financialStatements').map((r) => r.documentId)).toEqual([h('b')])
    expect(status(name, 'financialStatements').map((s) => [s.documentId, s.status])).toEqual([[h('b'), 'extracted']])
  })

  it('the replaced row stays in the view: the audit record is untouched', () => {
    const v = FIXTURES['SYS-3721: financial statement replaced']!()
    expect(v.categories['document-intake']!.instances).toHaveLength(2)
    expect(instanceRowsFromView(v, 'document-intake')).toHaveLength(2)
  })

  it('job status no longer lands one document later than v1', () => {
    // v1's pointer after the replacement holds b, c, d: job 1 belongs to the
    // first CURRENT file, not to the replaced one.
    const jobs: ExtractionJobRecord[] = [
      { fileType: 'bankStatements', status: ExtractionJobStatus.Failed, errorMessage: 'first' },
      { fileType: 'bankStatements', status: ExtractionJobStatus.Processing },
    ]
    const s = status('SYS-3721: first of three bank statements replaced', 'bankStatements', jobs)
    expect(s.map((x) => [x.documentId, x.status, x.errorMessage ?? null])).toEqual([
      [h('b'), 'extracted', 'first'],
      [h('c'), 'processing', null],
      [h('d'), 'extracted', null],
    ])
  })

  it("a replaced file's surviving extraction does not come back as an extraction-only document", () => {
    const d = docs('SYS-3721: replaced statement whose extraction was not purged', 'bankStatements')
    expect(d.map((x) => [x.hash, x.origin])).toEqual([[h('b'), 'intake']])
  })

  it("flatRecordFromView's v1 pointer array lists the current file only, as finsys-api's own v1 response does", () => {
    const fsFlat = flatRecordFromView(FIXTURES['SYS-3721: financial statement replaced']!())
    expect(fsFlat.record.financialStatements).toEqual([{ path: `${DMS}${h('b')}` }])
    const bankFlat = flatRecordFromView(FIXTURES['SYS-3721: first of three bank statements replaced']!())
    expect(bankFlat.record.bankStatements).toEqual([h('b'), h('c'), h('d')].map((x) => ({ path: `${DMS}${x}` })))
    // A single save: every file stays in the array.
    const one = flatRecordFromView(FIXTURES['control: three bank statements, one save, two extracted']!())
    expect((one.record.bankStatements as unknown[]).length).toBe(3)
  })

  // Review of ec4d7b6 (PROVEN by probe): a replaced pre-Phase-4b statement's
  // legacy rows attached to its REPLACEMENT, so a replacement not yet
  // extracted showed the old statement's figures as `extracted`.
  const SAVE_0 = '2026-06-01T06:00:00.000Z' // the old statement's extraction, before either save below
  it("a replaced statement's legacy rows do not attach to its replacement: pending stays pending, failed stays failed", () => {
    run = 0
    const v = view(
      [intake('financialStatements', h('a'), SAVE_1), intake('financialStatements', h('b'), SAVE_2)],
      {
        'financial-statement': [
          fs('legacy:T1', 1, { periodPosition: 1, legacySlot: 'T1', observedAt: SAVE_0 }),
          fs('legacy:T2', 2, { periodPosition: 2, legacySlot: 'T2', observedAt: SAVE_0 }),
        ],
      },
    )
    const d = documentsOfType(v, v.categories['document-intake']!.instances, 'financialStatements')
    expect(d.map((x) => [x.hash, x.origin, x.extraction.length])).toEqual([[h('b'), 'intake', 0]])
    const failed = resolveExtractionStatusFromView(v, [
      { fileType: 'financialStatements', status: ExtractionJobStatus.Failed, errorMessage: 'boom' },
    ]).documents.filter((x) => x.fileType === 'financialStatements')
    expect(failed.map((x) => [x.documentId, x.status])).toEqual([[h('b'), 'failed']])
    const pending = resolveExtractionStatusFromView(v, []).documents.filter((x) => x.fileType === 'financialStatements')
    expect(pending.map((x) => [x.documentId, x.status])).toEqual([[h('b'), 'uploaded']])
  })

  it('a PATCH that re-attests an UNREPLACED statement leaves its older legacy rows attached (no superseded row, no evidence)', () => {
    // updateIhsThirdParty re-attests every pointer column on any PATCH, so the
    // intake row is routinely newer than the legacy extraction. Without a
    // superseded row of the type that says nothing about replacement.
    run = 0
    const v = view([intake('financialStatements', h('d'), SAVE_2)], {
      'financial-statement': [
        fs('legacy:T1', 1, { periodPosition: 1, legacySlot: 'T1', observedAt: SAVE_0 }),
        fs('legacy:T2', 2, { periodPosition: 2, legacySlot: 'T2', observedAt: SAVE_0 }),
      ],
    })
    const d = documentsOfType(v, v.categories['document-intake']!.instances, 'financialStatements')
    expect(d.map((x) => [x.hash, x.extraction.map((e) => e.instanceKey)])).toEqual([[h('d'), ['legacy:T1', 'legacy:T2']]])
  })

  it('a legacy row extracted AFTER the current save still attaches, even when the type has a superseded row', () => {
    run = 0
    const later = '2026-06-01T07:00:00.000Z'
    const v = view(
      [intake('financialStatements', h('a'), SAVE_1), intake('financialStatements', h('b'), SAVE_2)],
      { 'financial-statement': [fs('legacy:T1', 1, { periodPosition: 1, legacySlot: 'T1', observedAt: later })] },
    )
    const d = documentsOfType(v, v.categories['document-intake']!.instances, 'financialStatements')
    expect(d.map((x) => [x.hash, x.extraction.map((e) => e.instanceKey)])).toEqual([[h('b'), ['legacy:T1']]])
  })

  it('a tie at the newest instant is ONE save: every file in it is current, whatever the offset', () => {
    expect(docs('control: one save written in two UTC offsets is one instant', 'bankStatements').map((x) => x.hash)).toEqual([h('a'), h('b')])
  })

  it('no parseable observedAt on a row of the type: nothing of that type is hidden', () => {
    expect(docs('control: an intake row with no observedAt leaves its type unfiltered', 'bankStatements').map((x) => x.hash)).toEqual([h('a'), h('b')])
  })

  it('an unparseable observedAt is treated like a missing one', () => {
    run = 0
    const v = view([intake('bankStatements', h('a'), 'not a time'), intake('bankStatements', h('b'), SAVE_2)], {})
    expect(documentsOfType(v, v.categories['document-intake']!.instances, 'bankStatements').map((x) => x.hash)).toEqual([h('a'), h('b')])
  })

  it('the rule is per document type: a newer save of one type hides nothing of another', () => {
    run = 0
    const v = view([intake('bankStatements', h('a'), SAVE_1), intake('financialStatements', h('d'), SAVE_2)], {})
    const i = v.categories['document-intake']!.instances
    expect(documentsOfType(v, i, 'bankStatements').map((x) => x.hash)).toEqual([h('a')])
    expect(documentsOfType(v, i, 'financialStatements').map((x) => x.hash)).toEqual([h('d')])
  })
})

describe('diagnostics', () => {
  it('writes digests when asked', () => {
    if (process.env.SYS3720_CAPTURE) writeFileSync(process.env.SYS3720_CAPTURE, JSON.stringify(allDigests(), null, 2) + '\n')
    expect(Object.keys(FIXTURES).length).toBeGreaterThan(0)
  })
})
