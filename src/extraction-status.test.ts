import { describe, it, expect } from 'vitest'
import { resolveExtractionStatus, DocExtractionStatus } from './extraction-status.js'
import { ExtractionFileType } from './extraction.js'

describe('resolveExtractionStatus', () => {
  describe('single-file types (ssm, form9, ic)', () => {
    it('returns not_uploaded when file path field is empty', () => {
      const ihsRecord = { ihsId: 1, fullName: 'Test' }
      const result = resolveExtractionStatus(ihsRecord)
      const ssm = result.documents.find((d) => d.fileType === ExtractionFileType.Ssm)
      expect(ssm?.status).toBe(DocExtractionStatus.NotUploaded)
    })

    it('returns not_uploaded when file path field is null', () => {
      const ihsRecord = { ihsId: 1, ssm: null }
      const result = resolveExtractionStatus(ihsRecord)
      const ssm = result.documents.find((d) => d.fileType === ExtractionFileType.Ssm)
      expect(ssm?.status).toBe(DocExtractionStatus.NotUploaded)
    })

    it('returns extracted when extraction columns are populated', () => {
      const ihsRecord = {
        ihsId: 1,
        ssm: 'https://storage.blob.core.windows.net/docs/ssm.pdf',
        ssmCompanyName: 'Test Sdn Bhd',
        ssmCompanyRegNo: '202001012345',
      }
      const result = resolveExtractionStatus(ihsRecord)
      const ssm = result.documents.find((d) => d.fileType === ExtractionFileType.Ssm)
      expect(ssm?.status).toBe(DocExtractionStatus.Extracted)
      expect(ssm?.populatedColumns).toContain('ssmCompanyName')
      expect(ssm?.populatedColumns).toContain('ssmCompanyRegNo')
      expect(ssm?.totalColumns).toBeGreaterThan(0)
    })

    it('returns extracted for IC when ic columns are populated', () => {
      const ihsRecord = {
        ihsId: 1,
        ic: '[{"path":"https://blob/ic.pdf"}]',
        icName: 'Ahmad bin Ali',
        icNumber: '900101-14-5678',
      }
      const result = resolveExtractionStatus(ihsRecord)
      const ic = result.documents.find((d) => d.fileType === ExtractionFileType.Ic)
      expect(ic?.status).toBe(DocExtractionStatus.Extracted)
      expect(ic?.populatedColumns).toContain('icName')
    })

    it('returns unknown when file exists but no extraction columns populated and no jobs', () => {
      const ihsRecord = {
        ihsId: 1,
        ssm: 'https://storage.blob.core.windows.net/docs/ssm.pdf',
      }
      const result = resolveExtractionStatus(ihsRecord)
      const ssm = result.documents.find((d) => d.fileType === ExtractionFileType.Ssm)
      expect(ssm?.status).toBe(DocExtractionStatus.Unknown)
    })

    it('returns uploaded when empty job records array is passed', () => {
      const ihsRecord = {
        ihsId: 1,
        ssm: 'https://blob/ssm.pdf',
      }
      const result = resolveExtractionStatus(ihsRecord, [])
      const ssm = result.documents.find((d) => d.fileType === ExtractionFileType.Ssm)
      expect(ssm?.status).toBe(DocExtractionStatus.Uploaded)
    })
  })

  describe('multi-file types (bank statements, etc.)', () => {
    it('produces one result per uploaded file', () => {
      const ihsRecord = {
        ihsId: 1,
        bankStatements: JSON.stringify([
          { path: 'https://blob/bank1.pdf', month: 1, year: 2026 },
          { path: 'https://blob/bank2.pdf', month: 2, year: 2026 },
          { path: 'https://blob/bank3.pdf', month: 3, year: 2026 },
        ]),
        bankNameT1: 'CIMB',
        bankBalanceT1: 50000,
        bankNameT2: 'Maybank',
        bankBalanceT2: 30000,
        // T3 not extracted
      }
      const result = resolveExtractionStatus(ihsRecord)
      const bankDocs = result.documents.filter(
        (d) => d.fileType === ExtractionFileType.BankStatement
      )
      expect(bankDocs).toHaveLength(3)
      expect(bankDocs[0].status).toBe(DocExtractionStatus.Extracted)
      expect(bankDocs[0].populatedColumns).toContain('bankNameT1')
      expect(bankDocs[1].status).toBe(DocExtractionStatus.Extracted)
      expect(bankDocs[1].populatedColumns).toContain('bankNameT2')
      expect(bankDocs[2].status).toBe(DocExtractionStatus.Unknown)
    })

    it('detects uploaded bank statements via aggregate key', () => {
      const ihsRecord = {
        ihsId: 1,
        bankStatements: '[{"path":"https://blob/bank1.pdf","month":1,"year":2026}]',
      }
      const result = resolveExtractionStatus(ihsRecord)
      const bankDocs = result.documents.filter(
        (d) => d.fileType === ExtractionFileType.BankStatement
      )
      expect(bankDocs).toHaveLength(1)
      expect(bankDocs[0].status).toBe(DocExtractionStatus.Unknown)
    })

    it('returns correct status per-file with job records', () => {
      const ihsRecord = {
        ihsId: 1,
        bankStatements: JSON.stringify([
          { path: 'https://blob/bank1.pdf' },
          { path: 'https://blob/bank2.pdf' },
        ]),
        bankNameT1: 'CIMB',
        bankBalanceT1: 50000,
      }
      const jobs = [
        { fileType: 'bankStatements', status: 'succeeded' },
        { fileType: 'bankStatements', status: 'processing' },
      ]
      const result = resolveExtractionStatus(ihsRecord, jobs)
      const bankDocs = result.documents.filter(
        (d) => d.fileType === ExtractionFileType.BankStatement
      )
      expect(bankDocs).toHaveLength(2)
      expect(bankDocs[0].status).toBe(DocExtractionStatus.Extracted)
      expect(bankDocs[1].status).toBe(DocExtractionStatus.Processing)
    })

    it('returns single not_uploaded when no bank statements exist', () => {
      const ihsRecord = { ihsId: 1 }
      const result = resolveExtractionStatus(ihsRecord)
      const bankDocs = result.documents.filter(
        (d) => d.fileType === ExtractionFileType.BankStatement
      )
      expect(bankDocs).toHaveLength(1)
      expect(bankDocs[0].status).toBe(DocExtractionStatus.NotUploaded)
    })
  })

  describe('with job records', () => {
    it('returns queued when job record says queued', () => {
      const ihsRecord = {
        ihsId: 1,
        ssm: 'https://blob/ssm.pdf',
      }
      const jobs = [{ fileType: 'ssm', status: 'queued' }]
      const result = resolveExtractionStatus(ihsRecord, jobs)
      const ssm = result.documents.find((d) => d.fileType === ExtractionFileType.Ssm)
      expect(ssm?.status).toBe(DocExtractionStatus.Queued)
    })

    it('returns processing when job record says processing', () => {
      const ihsRecord = {
        ihsId: 1,
        ssm: 'https://blob/ssm.pdf',
      }
      const jobs = [{ fileType: 'ssm', status: 'processing' }]
      const result = resolveExtractionStatus(ihsRecord, jobs)
      const ssm = result.documents.find((d) => d.fileType === ExtractionFileType.Ssm)
      expect(ssm?.status).toBe(DocExtractionStatus.Processing)
    })

    it('returns failed when job says failed and no extracted data', () => {
      const ihsRecord = {
        ihsId: 1,
        ssm: 'https://blob/ssm.pdf',
      }
      const jobs = [{ fileType: 'ssm', status: 'failed', errorMessage: 'OCR timeout' }]
      const result = resolveExtractionStatus(ihsRecord, jobs)
      const ssm = result.documents.find((d) => d.fileType === ExtractionFileType.Ssm)
      expect(ssm?.status).toBe(DocExtractionStatus.Failed)
      expect(ssm?.errorMessage).toBe('OCR timeout')
    })

    it('returns extracted with errorMessage when job failed but old data exists', () => {
      const ihsRecord = {
        ihsId: 1,
        ssm: 'https://blob/ssm.pdf',
        ssmCompanyName: 'Old Extraction Data',
      }
      const jobs = [{ fileType: 'ssm', status: 'failed', errorMessage: 'Re-extraction failed' }]
      const result = resolveExtractionStatus(ihsRecord, jobs)
      const ssm = result.documents.find((d) => d.fileType === ExtractionFileType.Ssm)
      expect(ssm?.status).toBe(DocExtractionStatus.Extracted)
      expect(ssm?.errorMessage).toBe('Re-extraction failed')
    })

    it('returns extracted when job says succeeded', () => {
      const ihsRecord = {
        ihsId: 1,
        ssm: 'https://blob/ssm.pdf',
      }
      const jobs = [{ fileType: 'ssm', status: 'succeeded' }]
      const result = resolveExtractionStatus(ihsRecord, jobs)
      const ssm = result.documents.find((d) => d.fileType === ExtractionFileType.Ssm)
      expect(ssm?.status).toBe(DocExtractionStatus.Extracted)
    })

    it('returns uploaded when job records provided but no match for this doc type', () => {
      const ihsRecord = {
        ihsId: 1,
        ssm: 'https://blob/ssm.pdf',
      }
      const jobs = [{ fileType: 'bankStatements', status: 'succeeded' }]
      const result = resolveExtractionStatus(ihsRecord, jobs)
      const ssm = result.documents.find((d) => d.fileType === ExtractionFileType.Ssm)
      expect(ssm?.status).toBe(DocExtractionStatus.Uploaded)
    })
  })

  describe('summary', () => {
    it('counts document statuses correctly', () => {
      const ihsRecord = {
        ihsId: 1,
        ssm: 'https://blob/ssm.pdf',
        ssmCompanyName: 'Test',
        ic: '[{"path":"https://blob/ic.pdf"}]',
      }
      const result = resolveExtractionStatus(ihsRecord)
      expect(result.summary.extracted).toBeGreaterThanOrEqual(1)
    })

    it('summary counts sum to total', () => {
      const ihsRecord = {
        ihsId: 1,
        ssm: 'https://blob/ssm.pdf',
        ssmCompanyName: 'Test',
      }
      const result = resolveExtractionStatus(ihsRecord)
      const { total, extracted, failed, pending, notUploaded } = result.summary
      expect(extracted + failed + pending + notUploaded).toBe(total)
    })
  })

  describe('displayName', () => {
    it('uses GROUP_DISPLAY_NAMES for known types', () => {
      const ihsRecord = { ihsId: 1, ssm: 'https://blob/ssm.pdf', ssmCompanyName: 'Test' }
      const result = resolveExtractionStatus(ihsRecord)
      const ssm = result.documents.find((d) => d.fileType === ExtractionFileType.Ssm)
      expect(ssm?.displayName).toBe('SSM Company Information')
    })
  })
})
