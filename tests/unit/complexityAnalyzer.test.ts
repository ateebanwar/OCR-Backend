import { describe, it, expect } from 'vitest';
import { analyzeDocumentComplexity } from '../../src/documents/complexityAnalyzer';

describe('Document Complexity Analyzer', () => {
  it('classifies a standard small PDF as LEVEL_1_SIMPLE', () => {
    const fakePdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\ntrailer\n%%EOF');
    const result = analyzeDocumentComplexity(fakePdf, 0);

    expect(result.level).toBe('LEVEL_1_SIMPLE');
    expect(result.estimatedPageCount).toBe(1);
    expect(result.recommendedModel).toBeDefined();
  });

  it('classifies multi-page document (> 5 pages) as LEVEL_2_COMPLEX', () => {
    let content = '%PDF-1.4\n';
    for (let i = 0; i < 8; i++) {
      content += `${i + 1} 0 obj\n<< /Type /Page >>\nendobj\n`;
    }
    content += '%%EOF';

    const pdfBuffer = Buffer.from(content);
    const result = analyzeDocumentComplexity(pdfBuffer, 0);

    expect(result.level).toBe('LEVEL_2_COMPLEX');
    expect(result.estimatedPageCount).toBe(8);
  });

  it('escalates to LEVEL_3_AMBIGUOUS when previous attempts have failed multiple times', () => {
    const fakePdf = Buffer.from('%PDF-1.4\n<< /Type /Page >>\n%%EOF');
    const result = analyzeDocumentComplexity(fakePdf, 2);

    expect(result.level).toBe('LEVEL_3_AMBIGUOUS');
    expect(result.reasons.some(r => r.includes('failed 2 times'))).toBe(true);
  });
});
