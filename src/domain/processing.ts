/**
 * Processing Domain Models: Lifecycles, Complexity, and Reconciliation States
 */

import { ModelInvocationRecord } from './telemetry';
import { VerificationGateResult } from '../validation/verificationGate';

export type ProcessingStage =
  | 'RECEIVED'
  | 'VALIDATING_FILE'
  | 'DOCUMENT_HASHED'
  | 'ANALYZING_COMPLEXITY'
  | 'EXTRACTING'
  | 'VALIDATING_STRUCTURE'
  | 'VALIDATING_SEMANTICS'
  | 'RECONCILING'
  | 'VERIFYING_SECOND_PASS'
  | 'CORRECTION_RETRY'
  | 'ESCALATING_MODEL'
  | 'CANONICAL_DATASET_READY'
  | 'GENERATING_XLSX'
  | 'VERIFYING_XLSX'
  | 'COMPLETED'
  | 'FAILED';

export type DocumentComplexityLevel = 'LEVEL_1_SIMPLE' | 'LEVEL_2_COMPLEX' | 'LEVEL_3_AMBIGUOUS';

export interface ComplexitySignals {
  pageCount: number;
  byteSize: number;
  imageCount: number;
  streamCount: number;
  textStreamCount: number;
  gridVectorCount: number;
  hasTableHeaders: boolean;
  tableHeaderMatches: string[];
  financialTokensCount: number;
  hasMultiCurrency: boolean;
  hasStatementMarkers: boolean;
  hasMultipleTotals: boolean;
  isScannedHeavy: boolean;
  multiPageTableRisk: boolean;
  uncertaintyScore: number;
  confidence: number;
}

export interface ComplexityAnalysisResult {
  level: DocumentComplexityLevel;
  score: number;
  signals: ComplexitySignals;
  reasons: string[];
  selectedTier: 'TIER_1_SIMPLE' | 'TIER_2_COMPLEX' | 'TIER_3_ESCALATION';
  recommendedModel: string;
  estimatedPageCount: number;
}

export type ReconciliationStatus =
  | 'EXACT_MATCH'
  | 'ACCEPTABLE_ROUNDING'
  | 'DISCREPANCY'
  | 'MISSING_DATA';

export interface LineItemReconciliation {
  lineNumber: number;
  description: string;
  quantity: number;
  unitPrice: number;
  discount: number | null;
  taxRate: number | null;
  calculatedSubtotal: number;
  calculatedTotal: number;
  extractedTotal: number;
  variance: number;
  isMatched: boolean;
  notes: string | null;
}

export interface TotalsReconciliation {
  calculatedSubtotal: number;
  extractedSubtotal: number | null;
  subtotalVariance: number;
  calculatedTaxTotal: number;
  extractedTaxTotal: number | null;
  taxVariance: number;
  calculatedGrandTotal: number;
  extractedGrandTotal: number;
  grandTotalVariance: number;
  calculatedBalanceDue: number | null;
  extractedBalanceDue: number | null;
  balanceDueVariance: number | null;
  status: ReconciliationStatus;
  discrepancies: string[];
  isVerified: boolean;
}

export interface CalculationConventions {
  subtotalConvention: 'GROSS' | 'NET' | 'TAX_INCLUSIVE' | 'DERIVED' | 'UNKNOWN';
  taxConvention: 'PER_LINE' | 'SUBTOTAL_LEVEL' | 'BREAKDOWN_SUM' | 'ZERO_TAX' | 'UNKNOWN';
  sourceRoundingApplied: number;
}

export interface FinancialReconciliationReport {
  documentId: string;
  reconciledAt: string;
  overallStatus: ReconciliationStatus;
  isVerified: boolean;
  toleranceApplied: number; // Strictly 0.0 (Zero arbitrary tolerance policy)
  currency: string;
  currencyPrecision: number;
  conventions?: CalculationConventions;
  lineItems: LineItemReconciliation[];
  totals: TotalsReconciliation;
  discrepancies: string[];
  auditNotes: string[];
}

export interface StageDuration {
  stage: ProcessingStage;
  durationMs: number;
  timestamp: string;
}

export interface ProcessingAuditTrail {
  stages: StageDuration[];
  totalProcessingTimeMs: number;
  complexityLevel?: DocumentComplexityLevel;
  complexityScore?: number;
  complexitySignals?: Record<string, unknown>;
  selectedModelTier?: string;
  selectedModel?: string;
  verificationModel?: string;
  fallbackUsed?: boolean;
  fallbackModel?: string;
  retryCount: number;
  escalationCount: number;
  correctionCount?: number;
  modelsUsed: string[];
  modelInvocations?: ModelInvocationRecord[];
  verificationGate?: VerificationGateResult;
}
