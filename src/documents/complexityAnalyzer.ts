import zlib from 'node:zlib';
import { ComplexityAnalysisResult, ComplexitySignals, DocumentComplexityLevel } from '../domain/processing';
import { getModelHierarchy } from '../config/models';

/**
 * Enhanced Financial Document Intelligence & Complexity Analyzer
 *
 * Implements multi-signal PDF inspection:
 * - Structural: page count, byte size, image density, content stream counts
 * - Tabular: vector grid lines (re/m/l/s/f operators), table header co-occurrence, coordinate alignment
 * - Financial: tax breakdowns, multiple totals, statement markers, multi-currency
 * - Extraction Risk: scanned vs text ratio, multi-page continuation risk, previous failure history
 * - Safety-First Routing: uncertainty boosts capability tier rather than degrading to weak models
 */

export function estimatePageCount(buffer: Buffer): number {
  const content = buffer.toString('latin1');
  const matches = content.match(/\/Type\s*\/Page\b/g);
  if (matches && matches.length > 0) {
    return matches.length;
  }

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

/**
 * Extracts and decompresses text/content streams from the PDF buffer safely.
 * Bounded by maxStreams and maxDecompressedBytes to guarantee resilience against DoS.
 */
export function extractContentStreams(
  buffer: Buffer,
  maxStreams = 30,
  maxDecompressedBytes = 1024 * 1024
): string[] {
  const raw = buffer.toString('latin1');
  const streams: string[] = [];
  const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;

  let match: RegExpExecArray | null;
  let totalDecompressed = 0;

  while ((match = streamRegex.exec(raw)) !== null && streams.length < maxStreams) {
    const streamContent = match[1];
    if (!streamContent) continue;

    // Check if stream is Flate compressed
    const streamBuffer = Buffer.from(streamContent, 'latin1');
    let decompressed: string | null = null;

    try {
      const inflated = zlib.inflateSync(streamBuffer);
      decompressed = inflated.toString('latin1');
    } catch {
      // If inflate fails, attempt unzipSync or fallback to raw content if plain text
      try {
        const unzipped = zlib.unzipSync(streamBuffer);
        decompressed = unzipped.toString('latin1');
      } catch {
        if (/[\x20-\x7E]{10,}/.test(streamContent)) {
          decompressed = streamContent;
        }
      }
    }

    if (decompressed) {
      streams.push(decompressed);
      totalDecompressed += decompressed.length;
      if (totalDecompressed >= maxDecompressedBytes) {
        break;
      }
    }
  }

  return streams;
}

const TABLE_HEADER_KEYWORDS = [
  'description',
  'quantity',
  'qty',
  'unit price',
  'unit cost',
  'rate',
  'amount',
  'line total',
  'subtotal',
  'item',
  'hours',
  'sku',
  'product',
  'particulars',
];

const FINANCIAL_STATEMENT_KEYWORDS = [
  'balance forward',
  'statement period',
  'opening balance',
  'closing balance',
  'account statement',
  'debit',
  'credit',
  'ledger',
  'previous balance',
];

const TOTALS_KEYWORDS = [
  'subtotal',
  'sub-total',
  'grand total',
  'total amount',
  'total due',
  'balance due',
  'amount paid',
  'amount due',
  'net amount',
  'gross amount',
];

const TAX_KEYWORDS = [
  'tax',
  'vat',
  'gst',
  'hst',
  'sales tax',
  'tax rate',
  'tax amount',
  'discount',
  'shipping',
  'freight',
];

const CURRENCY_SYMBOLS = ['$', '€', '£', '¥', '₹', 'USD', 'EUR', 'GBP', 'CAD', 'AUD'];

export function analyzeDocumentComplexity(
  buffer: Buffer,
  previousFailureCount = 0
): ComplexityAnalysisResult {
  const hierarchy = getModelHierarchy();
  const pageCount = estimatePageCount(buffer);
  const imageCount = detectImageDensity(buffer);
  const byteSize = buffer.length;
  const reasons: string[] = [];

  // Extract content streams for deep structural inspection
  const streams = extractContentStreams(buffer);
  const streamCount = streams.length;
  const combinedText = streams.join('\n').toLowerCase();

  // 1. Vector grid lines & table border analysis
  // Checks PDF drawing operators: rectangle (re), moveto (m), lineto (l), stroke (s/S)
  let gridVectorCount = 0;
  for (const stream of streams) {
    const reMatches = stream.match(/\b\d+\.?\d*\s+\d+\.?\d*\s+\d+\.?\d*\s+\d+\.?\d*\s+re\b/g);
    const lineMatches = stream.match(/\b\d+\.?\d*\s+\d+\.?\d*\s+[ml]\b/g);
    if (reMatches) gridVectorCount += reMatches.length;
    if (lineMatches) gridVectorCount += Math.floor(lineMatches.length / 2);
  }

  // 2. Table header co-occurrence
  const matchedHeaders: string[] = [];
  for (const kw of TABLE_HEADER_KEYWORDS) {
    if (combinedText.includes(kw)) {
      matchedHeaders.push(kw);
    }
  }
  const hasTableHeaders = matchedHeaders.length >= 3;

  // 3. Financial structure signals
  let financialTokensCount = 0;
  for (const kw of [...TOTALS_KEYWORDS, ...TAX_KEYWORDS]) {
    const matches = combinedText.match(new RegExp(`\\b${kw}\\b`, 'g'));
    if (matches) financialTokensCount += matches.length;
  }

  // 4. Statement & Multi-currency signals
  let statementMatchesCount = 0;
  for (const kw of FINANCIAL_STATEMENT_KEYWORDS) {
    if (combinedText.includes(kw)) statementMatchesCount++;
  }
  const hasStatementMarkers = statementMatchesCount >= 2;

  let currencyCount = 0;
  for (const cur of CURRENCY_SYMBOLS) {
    if (combinedText.includes(cur.toLowerCase())) currencyCount++;
  }
  const hasMultiCurrency = currencyCount > 1;

  // 5. Multiple totals check
  let totalsCount = 0;
  for (const tot of TOTALS_KEYWORDS) {
    if (combinedText.includes(tot)) totalsCount++;
  }
  const hasMultipleTotals = totalsCount >= 3;

  // 6. Scanned vs Text ratio
  const textCharsCount = combinedText.replace(/\s+/g, '').length;
  const isScannedHeavy = imageCount > 0 && textCharsCount < 200;

  // 7. Multi-page table risk
  const hasContinuationMarker =
    combinedText.includes('continued') ||
    combinedText.includes('carried forward') ||
    combinedText.includes('balance b/f') ||
    combinedText.includes('page 2');
  const multiPageTableRisk =
    pageCount > 1 && hasTableHeaders && (hasContinuationMarker || gridVectorCount > 10 || pageCount > 2);

  // --- Calculate Granular Complexity Score (0 to 100) ---
  let tabularScore = 0;
  if (gridVectorCount > 50) tabularScore += 15;
  else if (gridVectorCount > 15) tabularScore += 10;
  else if (gridVectorCount > 0) tabularScore += 5;

  if (hasTableHeaders) tabularScore += 10;
  if (matchedHeaders.length >= 5) tabularScore += 5;

  let financialScore = 0;
  if (hasMultipleTotals) financialScore += 8;
  if (financialTokensCount > 10) financialScore += 7;
  else if (financialTokensCount > 4) financialScore += 4;
  if (hasStatementMarkers) financialScore += 10;

  let layoutDensityScore = 0;
  if (pageCount > 15) layoutDensityScore += 12;
  else if (pageCount > 5) layoutDensityScore += 8;
  else if (pageCount > 1) layoutDensityScore += 4;
  else layoutDensityScore += 2;

  if (byteSize > 4 * 1024 * 1024) layoutDensityScore += 8;
  else if (byteSize > 1.5 * 1024 * 1024) layoutDensityScore += 4;

  if (streamCount > 10) layoutDensityScore += 5;

  let riskUncertaintyScore = 0;
  if (isScannedHeavy) riskUncertaintyScore += 8;
  if (hasMultiCurrency) riskUncertaintyScore += 4;
  if (multiPageTableRisk) riskUncertaintyScore += 5;

  // History penalty
  if (previousFailureCount >= 2) riskUncertaintyScore += 20;
  else if (previousFailureCount === 1) riskUncertaintyScore += 10;

  // Composite raw score
  let totalScore = tabularScore + financialScore + layoutDensityScore + riskUncertaintyScore;

  // Confidence & Safety-first routing
  // If text streams were empty or contradictory (e.g. large file with no text streams detected)
  let confidence = 0.90;
  if (streamCount === 0 && byteSize > 100000) {
    confidence = 0.50; // High uncertainty
  } else if (isScannedHeavy) {
    confidence = 0.60;
  }

  // Safety-first boost: When confidence is low, uncertainty boost increases model capability
  if (confidence < 0.65) {
    const uncertaintyBoost = Math.round((1 - confidence) * 50);
    totalScore += uncertaintyBoost;
    reasons.push(`Uncertainty safety boost applied (+${uncertaintyBoost} pts due to low extraction confidence: ${(confidence * 100).toFixed(0)}%)`);
  }

  // Cap score between 0 and 100
  totalScore = Math.min(100, Math.max(0, totalScore));

  // Determine Level and Tier based on composite intelligence
  let level: DocumentComplexityLevel;
  let selectedTier: 'TIER_1_SIMPLE' | 'TIER_2_COMPLEX' | 'TIER_3_ESCALATION';

  if (previousFailureCount >= 2 || totalScore >= 40 || hasStatementMarkers || (hasMultiCurrency && multiPageTableRisk) || (multiPageTableRisk && pageCount > 8) || confidence < 0.40) {
    level = 'LEVEL_3_AMBIGUOUS';
    selectedTier = 'TIER_3_ESCALATION';
    if (previousFailureCount >= 2) {
      reasons.push(`Prior extraction/reconciliation failed ${previousFailureCount} times (forced Tier 3 escalation)`);
    }
    if (confidence < 0.40) {
      reasons.push(`Severe structural ambiguity / extremely low confidence (${(confidence * 100).toFixed(0)}%) forces Tier 3`);
    }
    if (hasStatementMarkers) {
      reasons.push('Financial statement structure detected (debit/credit/period balances)');
    }
    if (multiPageTableRisk && pageCount > 8) {
      reasons.push(`Extensive multi-page tabular package (${pageCount} pages with continuation table risk)`);
    }
    if (hasMultiCurrency && multiPageTableRisk) {
      reasons.push('Multi-currency multi-page continuation schedule detected');
    }
    if (totalScore >= 40) {
      reasons.push(`High composite risk score: ${totalScore}/100`);
    }
  } else if (previousFailureCount === 1 || totalScore >= 25 || confidence < 0.65 || (hasTableHeaders && gridVectorCount >= 8) || gridVectorCount > 15 || multiPageTableRisk || pageCount > 4 || isScannedHeavy) {
    level = 'LEVEL_2_COMPLEX';
    selectedTier = 'TIER_2_COMPLEX';
    if (multiPageTableRisk) {
      reasons.push('Multi-page tabular layout continuation risk detected');
    }
    if (previousFailureCount === 1) {
      reasons.push('Prior validation attempt required escalation');
    }
    if (confidence < 0.65) {
      reasons.push(`Low confidence (${(confidence * 100).toFixed(0)}%) routed to Tier 2 for safety`);
    }
    if (hasTableHeaders) {
      reasons.push(`Structured line-item table detected (${matchedHeaders.slice(0, 4).join(', ')})`);
    }
    if (gridVectorCount > 15) {
      reasons.push(`Tabular grid lines detected (${gridVectorCount} drawing vectors)`);
    }
    if (pageCount > 4) {
      reasons.push(`Multi-page layout: ${pageCount} pages`);
    }
    if (isScannedHeavy) {
      reasons.push('Scanned image-heavy document requiring advanced visual OCR');
    }
    if (totalScore >= 35) {
      reasons.push(`Moderate composite complexity score: ${totalScore}/100`);
    }
  } else {
    level = 'LEVEL_1_SIMPLE';
    selectedTier = 'TIER_1_SIMPLE';
    reasons.push(`Standard financial document structure (score: ${totalScore}/100)`);
  }

  const recommendedModel =
    selectedTier === 'TIER_1_SIMPLE'
      ? hierarchy.tier1Simple
      : selectedTier === 'TIER_2_COMPLEX'
      ? hierarchy.tier2Complex
      : hierarchy.tier3Escalation;

  const signals: ComplexitySignals = {
    pageCount,
    byteSize,
    imageCount,
    streamCount,
    textStreamCount: streams.filter((s) => /BT[\s\S]*?ET/.test(s)).length,
    gridVectorCount,
    hasTableHeaders,
    tableHeaderMatches: matchedHeaders,
    financialTokensCount,
    hasMultiCurrency,
    hasStatementMarkers,
    hasMultipleTotals,
    isScannedHeavy,
    multiPageTableRisk,
    uncertaintyScore: riskUncertaintyScore,
    confidence,
  };

  return {
    level,
    score: totalScore,
    signals,
    reasons,
    selectedTier,
    recommendedModel,
    estimatedPageCount: pageCount,
  };
}
