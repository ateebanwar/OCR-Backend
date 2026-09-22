import { ComplexityAnalysisResult, DocumentComplexityLevel } from '../domain/processing';
import { getModelHierarchy } from '../config/models';

/**
 * Analyzes PDF buffer structure and deterministic signals to classify document complexity.
 */
export function estimatePageCount(buffer: Buffer): number {
  const content = buffer.toString('latin1');
  const matches = content.match(/\/Type\s*\/Page\b/g);
  if (matches && matches.length > 0) {
    return matches.length;
  }

  // Fallback: check for /Pages /Count
  const countMatch = content.match(/\/Count\s+(\d+)/);
  if (countMatch && countMatch[1]) {
    const parsed = parseInt(countMatch[1], 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return 1;
}

export function detectImageDensity(buffer: Buffer): number {
  const content = buffer.toString('latin1');
  const imageMatches = content.match(/\/Subtype\s*\/Image\b/g);
  return imageMatches ? imageMatches.length : 0;
}

export function analyzeDocumentComplexity(
  buffer: Buffer,
  previousFailureCount = 0
): ComplexityAnalysisResult {
  const hierarchy = getModelHierarchy();
  const pageCount = estimatePageCount(buffer);
  const imageCount = detectImageDensity(buffer);
  const byteSize = buffer.length;
  const reasons: string[] = [];

  // Escalation if previous attempt failed
  if (previousFailureCount >= 2) {
    reasons.push(`Previous validation/reconciliation failed ${previousFailureCount} times`);
    return {
      level: 'LEVEL_3_AMBIGUOUS',
      reasons,
      recommendedModel: hierarchy.escalation,
      estimatedPageCount: pageCount,
    };
  }

  if (previousFailureCount === 1) {
    reasons.push('Previous validation attempt required escalation');
    return {
      level: 'LEVEL_2_COMPLEX',
      reasons,
      recommendedModel: hierarchy.complex,
      estimatedPageCount: pageCount,
    };
  }

  // Deterministic checks on PDF characteristics
  let level: DocumentComplexityLevel = 'LEVEL_1_SIMPLE';

  if (pageCount > 5) {
    reasons.push(`High page count: ${pageCount} pages`);
    level = 'LEVEL_2_COMPLEX';
  }

  if (imageCount > 10) {
    reasons.push(`High visual/scanned density: ${imageCount} embedded image objects`);
    level = 'LEVEL_2_COMPLEX';
  }

  if (byteSize > 4 * 1024 * 1024) {
    reasons.push(`Large document payload: ${(byteSize / (1024 * 1024)).toFixed(1)}MB`);
    level = 'LEVEL_2_COMPLEX';
  }

  if (pageCount > 15 || (pageCount > 8 && imageCount > 15)) {
    reasons.push(`Highly complex multi-page financial package (${pageCount} pages, ${imageCount} images)`);
    level = 'LEVEL_3_AMBIGUOUS';
  }

  const recommendedModel =
    level === 'LEVEL_1_SIMPLE'
      ? hierarchy.primary
      : level === 'LEVEL_2_COMPLEX'
      ? hierarchy.complex
      : hierarchy.escalation;

  if (reasons.length === 0) {
    reasons.push('Standard financial document structure');
  }

  return {
    level,
    reasons,
    recommendedModel,
    estimatedPageCount: pageCount,
  };
}
