import { describe, it, expect } from 'vitest'
import { resolveExtractionStatus, DocExtractionStatus } from './extraction-status.js'
import { ExtractionFileType } from './extraction.js'

describe('resolveExtractionStatus', () => {
  describe('not_uploaded', () => {
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
  })

  describe('extracted (from IHS columns)', () => {
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

    it('returns extracted for time-series when any period has data', () => {
      const ihsRecord = {
        ihsId: 1,
        bank_statement_t1: 'https://blob/bank1.pdf',
        bankBalanceT1: 50000,
        bankBalanceT2: null,
      }
      const result = resolveExtractionStatus(ihsRecord)
      const bank = result.documents.find((d) => d.fileType === ExtractionFileType.BankStatement)
      expect(bank?.status).toBe(DocExtractionStatus.Extracted)
    })
  })

  describe('unknown (uploaded but no job records provided)', () => {
    it('returns unknown when file exists but no extraction columns populated and no jobs', () => {
      const ihsRecord = {
        ihsId: 1,
        ssm: 'https://storage.blob.core.windows.net/docs/ssm.pdf',
      }
      const result = resolveExtractionStatus(ihsRecord)
      const ssm = result.documents.find((d) => d.fileType === ExtractionFileType.Ssm)
      expect(ssm?.status).toBe(DocExtractionStatus.Unknown)
    })
  })

  describe('uploaded (empty job records array)', () => {
    it('returns uploaded (not unknown) when empty job records array is passed', () => {
      const ihsRecord = {
        ihsId: 1,
        ssm: 'https://blob/ssm.pdf',
      }
      const result = resolveExtractionStatus(ihsRecord, [])
      const ssm = result.documents.find((d) => d.fileType === ExtractionFileType.Ssm)
      expect(ssm?.status).toBe(DocExtractionStatus.Uploaded)
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
      expect(result.summary.total).toBe(Object.values(ExtractionFileType).length)
      expect(result.summary.extracted).toBeGreaterThanOrEqual(1)
    })

    it('summary counts include notUploaded and sum to total', () => {
      const ihsRecord = {
        ihsId: 1,
        ssm: 'https://blob/ssm.pdf',
        ssmCompanyName: 'Test',
      }
      const result = resolveExtractionStatus(ihsRecord)
      const { total, extracted, failed, pending, notUploaded } = result.summary
      expect(total).toBe(Object.values(ExtractionFileType).length)
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
