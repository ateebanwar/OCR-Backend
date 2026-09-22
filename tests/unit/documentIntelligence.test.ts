import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import {
  analyzeDocumentComplexity,
  estimatePageCount,
  detectImageDensity,
  extractContentStreams,
} from '../../src/documents/complexityAnalyzer';

describe('Document Intelligence & Structural Feature Analysis', () => {
  it('correctly decompresses FlateDecode compressed streams inside PDF', () => {
    const rawStreamText = 'BT /F1 12 Tf 50 700 Td (Compressed Table Text) Tj ET';
    const compressed = zlib.deflateSync(Buffer.from(rawStreamText, 'latin1'));

    const fakePdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length 100 /Filter /FlateDecode >>\nstream\r\n'),
      compressed,
      Buffer.from('\r\nendstream\nendobj\n%%EOF'),
    ]);

    const extracted = extractContentStreams(fakePdf);
    expect(extracted.length).toBeGreaterThan(0);
    expect(extracted.some((s) => s.includes('Compressed Table Text'))).toBe(true);
  });

  it('detects vector grid lines and outlines from PDF drawing operators', () => {
    // 30 rectangle drawing operators
    let streamText = '';
    for (let i = 0; i < 30; i++) {
      streamText += `100 ${i * 20} 300 20 re S\n`;
    }

    const fakePdf = Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\nstream\n${streamText}\nendstream\n%%EOF`
    );

    const result = analyzeDocumentComplexity(fakePdf);
    expect(result.signals.gridVectorCount).toBe(30);
    expect(result.reasons.some((r) => r.includes('Tabular grid lines detected'))).toBe(true);
  });

  it('proves a 1-page document with dense tabular data and taxes is classified as COMPLEX, not simple', () => {
    // Single page with dense line items, table headers, and multiple tax rates
    let streamText = 'BT /F1 10 Tf (Description Quantity Unit Price Rate Line Total Subtotal Tax Discount Grand Total) Tj ET\n';
    for (let i = 0; i < 20; i++) {
      streamText += `50 ${i * 25} 400 20 re S\n`;
    }

    const singlePageComplexPdf = Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\nstream\n${streamText}\nendstream\n%%EOF`
    );

    const result = analyzeDocumentComplexity(singlePageComplexPdf);
    expect(result.estimatedPageCount).toBe(1);
    expect(result.signals.hasTableHeaders).toBe(true);
    expect(result.signals.gridVectorCount).toBeGreaterThan(15);
    // Page count is 1, but structural complexity routes to Tier 2!
    expect(result.level).toBe('LEVEL_2_COMPLEX');
    expect(result.selectedTier).toBe('TIER_2_COMPLEX');
  });

  it('detects image density and classifies scanned image-heavy PDFs correctly', () => {
    let content = '%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n';
    for (let i = 0; i < 12; i++) {
      content += `${i + 2} 0 obj\n<< /Type /XObject /Subtype /Image >>\nendobj\n`;
    }
    content += '%%EOF';

    const scannedPdf = Buffer.from(content);
    expect(detectImageDensity(scannedPdf)).toBe(12);

    const result = analyzeDocumentComplexity(scannedPdf);
    expect(result.signals.imageCount).toBe(12);
    expect(result.signals.isScannedHeavy).toBe(true);
    expect(result.level).toBe('LEVEL_2_COMPLEX');
  });

  it('detects multi-page continuation table risk', () => {
    let content = '%PDF-1.4\n';
    for (let i = 0; i < 6; i++) {
      content += `${i + 1} 0 obj\n<< /Type /Page >>\nendobj\n`;
    }
    content += 'stream\nBT (Description Quantity Unit Price Line Total Subtotal Tax) Tj ET\n10 10 100 20 re S\nendstream\n%%EOF';

    const multiPagePdf = Buffer.from(content);
    const result = analyzeDocumentComplexity(multiPagePdf);

    expect(result.estimatedPageCount).toBe(6);
    expect(result.signals.multiPageTableRisk).toBe(true);
    expect(result.level).toBe('LEVEL_2_COMPLEX');
  });
});
