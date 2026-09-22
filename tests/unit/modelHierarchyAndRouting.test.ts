import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig } from '../../src/config/env';
import {
  getModelHierarchy,
  selectModelForComplexity,
  getEscalationModel,
  getVerificationModel,
} from '../../src/config/models';
import { analyzeDocumentComplexity } from '../../src/documents/complexityAnalyzer';

describe('Model Hierarchy & Intelligent Routing Quality Gates', () => {
  beforeEach(() => {
    // Reset to defaults
    loadConfig({
      NODE_ENV: 'test',
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'test-api-key',
    });
  });

  it('Test A (Simple Document): Routes standard single-page invoice to Tier 1 (gemini-3.6-flash)', () => {
    const simplePdf = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\nstream\nBT /F1 12 Tf 100 700 Td (Invoice #101) Tj ET\nendstream\n%%EOF'
    );
    const analysis = analyzeDocumentComplexity(simplePdf);

    expect(analysis.selectedTier).toBe('TIER_1_SIMPLE');
    expect(analysis.level).toBe('LEVEL_1_SIMPLE');
    expect(analysis.recommendedModel).toBe('gemini-3.6-flash');
    expect(selectModelForComplexity(analysis.level)).toBe('gemini-3.6-flash');
  });

  it('Test B (Complex Tabular Document): Routes document with dense grid vectors and table headers to Tier 2 (gemini-3.7-flash)', () => {
    // Generate synthetic PDF content with drawing vectors and table headers
    let streamBody = 'BT /F1 10 Tf 50 700 Td (Description Quantity Unit Price Line Total Tax) Tj ET\n';
    for (let i = 0; i < 25; i++) {
      streamBody += `${i * 10} 100 200 15 re S\n`;
    }
    const complexPdf = Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\nstream\n${streamBody}\nendstream\n%%EOF`
    );

    const analysis = analyzeDocumentComplexity(complexPdf);

    expect(analysis.selectedTier).toBe('TIER_2_COMPLEX');
    expect(analysis.level).toBe('LEVEL_2_COMPLEX');
    expect(analysis.recommendedModel).toBe('gemini-3.7-flash');
    expect(analysis.signals.hasTableHeaders).toBe(true);
    expect(analysis.signals.gridVectorCount).toBeGreaterThan(15);
  });

  it('Test C (High-Risk Financial Statement): Routes statement with debit/credit markers or multi-page continuation to Tier 3 (gemini-3.8-flash)', () => {
    const statementPdf = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\nstream\nBT /F1 10 Tf (Account Statement Statement Period Opening Balance Closing Balance Debit Credit Ledger) Tj ET\nendstream\n%%EOF'
    );

    const analysis = analyzeDocumentComplexity(statementPdf);

    expect(analysis.selectedTier).toBe('TIER_3_ESCALATION');
    expect(analysis.level).toBe('LEVEL_3_AMBIGUOUS');
    expect(analysis.recommendedModel).toBe('gemini-3.8-flash');
    expect(analysis.signals.hasStatementMarkers).toBe(true);
  });

  it('Test D (Uncertain Document): Applies safety-first routing boost to avoid weak models when confidence is low', () => {
    // Binary-heavy PDF with no readable streams (low confidence)
    const uncertainPdf = Buffer.alloc(150000, 0x50); // 150KB without readable streams
    uncertainPdf.write('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n', 0, 'latin1');

    const analysis = analyzeDocumentComplexity(uncertainPdf);

    // Uncertainty must boost capability rather than degrading
    expect(analysis.signals.confidence).toBeLessThan(0.70);
    expect(analysis.reasons.some((r) => r.includes('Uncertainty safety boost'))).toBe(true);
    expect(analysis.selectedTier).not.toBe('TIER_1_SIMPLE');
  });

  it('Test E (Failure History Escalation): Prior extraction/reconciliation failure forces immediate model escalation', () => {
    const simplePdf = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\nstream\nBT (Invoice #1) Tj ET\nendstream\n%%EOF'
    );

    // Baseline: Tier 1
    const baseline = analyzeDocumentComplexity(simplePdf, 0);
    expect(baseline.selectedTier).toBe('TIER_1_SIMPLE');

    // 1 failure: escalates to Tier 2
    const oneFail = analyzeDocumentComplexity(simplePdf, 1);
    expect(oneFail.selectedTier).toBe('TIER_2_COMPLEX');
    expect(oneFail.recommendedModel).toBe('gemini-3.7-flash');

    // 2 failures: escalates to Tier 3
    const twoFails = analyzeDocumentComplexity(simplePdf, 2);
    expect(twoFails.selectedTier).toBe('TIER_3_ESCALATION');
    expect(twoFails.recommendedModel).toBe('gemini-3.8-flash');
  });

  it('Test F (Environment Overrides): Changing environment variables immediately and independently updates all model tiers', () => {
    loadConfig({
      NODE_ENV: 'test',
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'test-key',
      GEMINI_EXTRACTION_MODEL: 'custom-tier1',
      GEMINI_COMPLEX_EXTRACTION_MODEL: 'custom-tier2',
      GEMINI_ESCALATION_MODEL: 'custom-tier3',
      GEMINI_VERIFICATION_MODEL: 'custom-verif',
      GEMINI_CHAT_MODEL: 'custom-chat',
    });

    const hierarchy = getModelHierarchy();
    expect(hierarchy.tier1Simple).toBe('custom-tier1');
    expect(hierarchy.tier2Complex).toBe('custom-tier2');
    expect(hierarchy.tier3Escalation).toBe('custom-tier3');
    expect(hierarchy.verification).toBe('custom-verif');
    expect(hierarchy.chat).toBe('custom-chat');

    expect(selectModelForComplexity('LEVEL_1_SIMPLE')).toBe('custom-tier1');
    expect(selectModelForComplexity('LEVEL_2_COMPLEX')).toBe('custom-tier2');
    expect(selectModelForComplexity('LEVEL_3_AMBIGUOUS')).toBe('custom-tier3');
    expect(getEscalationModel(1)).toBe('custom-tier2');
    expect(getEscalationModel(2)).toBe('custom-tier3');
    expect(getVerificationModel()).toBe('custom-verif');
  });
});
