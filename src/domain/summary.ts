/**
 * Frontend API Response Summary Domain Models & Zod Schemas
 * 
 * Provides a clean, stable, strongly-typed post-conversion summary contract
 * for the React frontend, partitioned into 4 authoritative pillars:
 * 1. Document Summary
 * 2. Financial Summary
 * 3. Verification Summary
 * 4. Excel (XLSX) Summary
 * 
 * Zero financial calculation or reconciliation is performed by the frontend;
 * the backend remains the authoritative source of truth.
 */

import { z } from 'zod';
import { DocumentType } from './financial';
import { ReconciliationStatus, CalculationConventions } from './processing';
import { WorksheetVerificationInfo } from '../spreadsheet/xlsxVerifier';

// ==============================================================================
// 1. DOCUMENT SUMMARY
// ==============================================================================

export interface DocumentSummaryInfo {
  sourceFilename: string;
  documentType: DocumentType;
  invoiceNumber: string | null;
  documentNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  purchaseOrderNumber: string | null;
  referenceNumbers: string[];
  vendorName: string | null;
  customerName: string | null;
  currency: string;
  language: string | null;
  totalPdfPages: number;
  processedPages: number;
  extractedPages: number[];
  failedPages: number[];
  skippedPages: number[];
  extractionCompleteness: number; // 0.0 to 1.0
  isFullyCovered: boolean;
  extractedLineItemCount: number;
}

export const documentSummarySchema = z.object({
  sourceFilename: z.string().min(1),
  documentType: z.enum([
    'invoice',
    'bill',
    'purchase_order',
    'receipt',
    'statement',
    'tax_document',
    'accounting_document',
    'financial_report',
    'other',
  ]),
  invoiceNumber: z.string().nullable(),
  documentNumber: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  purchaseOrderNumber: z.string().nullable(),
  referenceNumbers: z.array(z.string()),
  vendorName: z.string().nullable(),
  customerName: z.string().nullable(),
  currency: z.string().min(1),
  language: z.string().nullable(),
  totalPdfPages: z.number().int().nonnegative(),
  processedPages: z.number().int().nonnegative(),
  extractedPages: z.array(z.number().int().positive()),
  failedPages: z.array(z.number().int().positive()),
  skippedPages: z.array(z.number().int().positive()),
  extractionCompleteness: z.number().min(0).max(1),
  isFullyCovered: z.boolean(),
  extractedLineItemCount: z.number().int().nonnegative(),
});

// ==============================================================================
// 2. FINANCIAL SUMMARY
// ==============================================================================

export interface TaxBreakdownSummary {
  name: string;
  rate: number | null;
  amount: number;
}

export interface FinancialSummaryInfo {
  // Authoritative financial totals
  currency: string;
  subtotal: number | null;
  discountTotal: number | null;
  taxTotal: number | null;
  taxBreakdown: TaxBreakdownSummary[] | null;
  shippingCharges: number | null;
  additionalCharges: number | null;
  rounding: number | null;
  grandTotal: number;
  paidAmount: number | null;
  balanceDue: number | null;

  // Authoritative reconciliation state
  overallReconciliationStatus: ReconciliationStatus;
  reconciliationVerificationStatus: boolean;
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
  discrepancies: string[];
  reconciliationConventions?: CalculationConventions;
  toleranceApplied: number; // Strictly 0.0
  currencyPrecision: number;
  sourceRoundingApplied: number;
}

export const taxBreakdownSummarySchema = z.object({
  name: z.string(),
  rate: z.number().nullable(),
  amount: z.number(),
});

export const calculationConventionsSchema = z.object({
  subtotalConvention: z.enum(['GROSS', 'NET', 'TAX_INCLUSIVE', 'DERIVED', 'UNKNOWN']),
  taxConvention: z.enum(['PER_LINE', 'SUBTOTAL_LEVEL', 'BREAKDOWN_SUM', 'ZERO_TAX', 'UNKNOWN']),
  sourceRoundingApplied: z.number(),
});

export const financialSummarySchema = z.object({
  currency: z.string().min(1),
  subtotal: z.number().nullable(),
  discountTotal: z.number().nullable(),
  taxTotal: z.number().nullable(),
  taxBreakdown: z.array(taxBreakdownSummarySchema).nullable(),
  shippingCharges: z.number().nullable(),
  additionalCharges: z.number().nullable(),
  rounding: z.number().nullable(),
  grandTotal: z.number(),
  paidAmount: z.number().nullable(),
  balanceDue: z.number().nullable(),

  overallReconciliationStatus: z.enum(['EXACT_MATCH', 'ACCEPTABLE_ROUNDING', 'DISCREPANCY', 'MISSING_DATA']),
  reconciliationVerificationStatus: z.boolean(),
  calculatedSubtotal: z.number(),
  extractedSubtotal: z.number().nullable(),
  subtotalVariance: z.number(),
  calculatedTaxTotal: z.number(),
  extractedTaxTotal: z.number().nullable(),
  taxVariance: z.number(),
  calculatedGrandTotal: z.number(),
  extractedGrandTotal: z.number(),
  grandTotalVariance: z.number(),
  calculatedBalanceDue: z.number().nullable(),
  extractedBalanceDue: z.number().nullable(),
  balanceDueVariance: z.number().nullable(),
  discrepancies: z.array(z.string()),
  reconciliationConventions: calculationConventionsSchema.optional(),
  toleranceApplied: z.number(),
  currencyPrecision: z.number().int().nonnegative(),
  sourceRoundingApplied: z.number(),
});

// ==============================================================================
// 3. VERIFICATION SUMMARY
// ==============================================================================

export interface VerificationSummaryInfo {
  isVerified: boolean;
  reconciliationVerified: boolean;
  secondPassVerified: boolean;
  completenessVerified: boolean;
  semanticVerified: boolean;
  xlsxVerified: boolean;
  verificationGateStatus: 'PASSED' | 'FAILED';
  gateFailureReasons: string[];
  discrepancies: string[];
}

export const verificationSummarySchema = z.object({
  isVerified: z.boolean(),
  reconciliationVerified: z.boolean(),
  secondPassVerified: z.boolean(),
  completenessVerified: z.boolean(),
  semanticVerified: z.boolean(),
  xlsxVerified: z.boolean(),
  verificationGateStatus: z.enum(['PASSED', 'FAILED']),
  gateFailureReasons: z.array(z.string()),
  discrepancies: z.array(z.string()),
});

// ==============================================================================
// 4. EXCEL (XLSX) SUMMARY
// ==============================================================================

export interface XlsxSummaryInfo {
  generatedXlsxFilename: string;
  xlsxValid: boolean;
  sheetCount: number;
  sheetNames: string[];
  totalRowCount: number;
  totalColumnCount: number;
  formulaCount: number;
  workbookErrors: string[];
  worksheetValidation: WorksheetVerificationInfo[];
  summarySheetPresent: boolean;
  lineItemsSheetPresent: boolean;
  auditSheetPresent: boolean;
}

export const worksheetVerificationSchema = z.object({
  name: z.string(),
  rowCount: z.number().int().nonnegative(),
  columnCount: z.number().int().nonnegative(),
  formulaCount: z.number().int().nonnegative(),
  isValid: z.boolean(),
});

export const xlsxSummarySchema = z.object({
  generatedXlsxFilename: z.string().min(1),
  xlsxValid: z.boolean(),
  sheetCount: z.number().int().nonnegative(),
  sheetNames: z.array(z.string()),
  totalRowCount: z.number().int().nonnegative(),
  totalColumnCount: z.number().int().nonnegative(),
  formulaCount: z.number().int().nonnegative(),
  workbookErrors: z.array(z.string()),
  worksheetValidation: z.array(worksheetVerificationSchema),
  summarySheetPresent: z.boolean(),
  lineItemsSheetPresent: z.boolean(),
  auditSheetPresent: z.boolean(),
});

// ==============================================================================
// AGGREGATE POST-CONVERSION SUMMARY
// ==============================================================================

export interface ConversionSummary {
  document: DocumentSummaryInfo;
  financial: FinancialSummaryInfo;
  verification: VerificationSummaryInfo;
  xlsx: XlsxSummaryInfo;
}

export const conversionSummarySchema = z.object({
  document: documentSummarySchema,
  financial: financialSummarySchema,
  verification: verificationSummarySchema,
  xlsx: xlsxSummarySchema,
});
