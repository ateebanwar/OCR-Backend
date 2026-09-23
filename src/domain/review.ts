/**
 * Correction & Review Workflow Domain Models & Zod Schemas
 * 
 * Provides canonical document statuses, structured issues, evidence tracking,
 * automatic correction records, and user review resolution states.
 */

import { z } from 'zod';

// ==============================================================================
// 1. CANONICAL DOCUMENT STATUS
// ==============================================================================

export type DocumentStatus =
  | 'VERIFIED'
  | 'VERIFIED_WITH_CORRECTIONS'
  | 'REVIEW_REQUIRED'
  | 'REJECTED';

export const documentStatusSchema = z.enum([
  'VERIFIED',
  'VERIFIED_WITH_CORRECTIONS',
  'REVIEW_REQUIRED',
  'REJECTED',
]);

// ==============================================================================
// 2. ISSUE TYPES, SEVERITY & RESOLUTION CHOICES
// ==============================================================================

export type IssueType =
  | 'EXTRACTION_CORRECTION'
  | 'AMBIGUOUS_VALUE'
  | 'RECONCILIATION_WARNING'
  | 'RECONCILIATION_ERROR'
  | 'COMPLETENESS_WARNING'
  | 'SEMANTIC_VALIDATION_WARNING'
  | 'SEMANTIC_VALIDATION_ERROR'
  | 'XLSX_VALIDATION_ERROR'
  | 'SECURITY_ERROR'
  | 'PROCESSING_ERROR';

export const issueTypeSchema = z.enum([
  'EXTRACTION_CORRECTION',
  'AMBIGUOUS_VALUE',
  'RECONCILIATION_WARNING',
  'RECONCILIATION_ERROR',
  'COMPLETENESS_WARNING',
  'SEMANTIC_VALIDATION_WARNING',
  'SEMANTIC_VALIDATION_ERROR',
  'XLSX_VALIDATION_ERROR',
  'SECURITY_ERROR',
  'PROCESSING_ERROR',
]);

export type IssueSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export const issueSeveritySchema = z.enum(['INFO', 'WARNING', 'ERROR', 'CRITICAL']);

export type IssueStatus = 'OPEN' | 'RESOLVED' | 'DISMISSED';

export const issueStatusSchema = z.enum(['OPEN', 'RESOLVED', 'DISMISSED']);

export type ResolutionDecision =
  | 'DISCOUNT'
  | 'CREDIT'
  | 'REFUND'
  | 'ADJUSTMENT'
  | 'OTHER'
  | 'KEEP_AS_IS';

export const resolutionDecisionSchema = z.enum([
  'DISCOUNT',
  'CREDIT',
  'REFUND',
  'ADJUSTMENT',
  'OTHER',
  'KEEP_AS_IS',
]);

export interface IssueEvidence {
  page?: number;
  text?: string;
  field?: string;
  context?: string;
}

export const issueEvidenceSchema = z.object({
  page: z.number().int().positive().optional(),
  text: z.string().optional(),
  field: z.string().optional(),
  context: z.string().optional(),
});

// ==============================================================================
// 3. STRUCTURED REVIEW ISSUE
// ==============================================================================

export interface ReviewIssue {
  id: string;
  type: IssueType;
  severity: IssueSeverity;
  status: IssueStatus;
  page: number;
  field: string;
  lineItemIndex?: number;
  originalValue: unknown;
  aiInterpretation: {
    field: string;
    value: unknown;
  };
  message: string;
  reason: string;
  evidence: IssueEvidence[];
  resolutionOptions: ResolutionDecision[];
  resolved: boolean;
  userDecision?: ResolutionDecision;
  customMeaning?: string | null;
  customValue?: unknown;
  resolvedAt?: string;
}

export const reviewIssueSchema = z.object({
  id: z.string().min(1),
  type: issueTypeSchema,
  severity: issueSeveritySchema,
  status: issueStatusSchema,
  page: z.number().int().nonnegative().default(1),
  field: z.string().min(1),
  lineItemIndex: z.number().int().nonnegative().optional(),
  originalValue: z.unknown(),
  aiInterpretation: z.object({
    field: z.string(),
    value: z.unknown(),
  }),
  message: z.string().min(1),
  reason: z.string().min(1),
  evidence: z.array(issueEvidenceSchema),
  resolutionOptions: z.array(resolutionDecisionSchema),
  resolved: z.boolean(),
  userDecision: resolutionDecisionSchema.optional(),
  customMeaning: z.string().nullable().optional(),
  customValue: z.unknown().optional(),
  resolvedAt: z.string().optional(),
});

// ==============================================================================
// 4. CORRECTION RECORD
// ==============================================================================

export interface CorrectionRecord {
  issueId: string;
  page: number;
  field: string;
  lineItemIndex?: number;
  originalField: string;
  originalValue: unknown;
  finalValue: unknown;
  reason: string;
  evidence: string[];
  resolved: boolean;
  timestamp: string;
  source: 'AUTOMATIC_ENGINE' | 'USER';
}

export const correctionRecordSchema = z.object({
  issueId: z.string().min(1),
  page: z.number().int().nonnegative().default(1),
  field: z.string().min(1),
  lineItemIndex: z.number().int().nonnegative().optional(),
  originalField: z.string().min(1),
  originalValue: z.unknown(),
  finalValue: z.unknown(),
  reason: z.string().min(1),
  evidence: z.array(z.string()),
  resolved: z.boolean(),
  timestamp: z.string(),
  source: z.enum(['AUTOMATIC_ENGINE', 'USER']),
});

// ==============================================================================
// 5. USER RESOLUTION & AUDIT
// ==============================================================================

export interface UserResolution {
  issueId: string;
  documentId: string;
  page?: number;
  field?: string;
  originalValue?: unknown;
  aiInterpretation?: unknown;
  userDecision: ResolutionDecision;
  customMeaning?: string | null;
  customValue?: unknown;
  finalValue?: unknown;
  resolved: boolean;
  timestamp: string;
  source: 'USER';
}

export const userResolutionSchema = z.object({
  issueId: z.string().min(1),
  documentId: z.string().min(1),
  page: z.number().int().nonnegative().optional(),
  field: z.string().optional(),
  originalValue: z.unknown().optional(),
  aiInterpretation: z.unknown().optional(),
  userDecision: resolutionDecisionSchema,
  customMeaning: z.string().max(500).nullable().optional(),
  customValue: z.unknown().optional(),
  finalValue: z.unknown().optional(),
  resolved: z.boolean(),
  timestamp: z.string(),
  source: z.literal('USER'),
});

// ==============================================================================
// 6. REVIEW STATE
// ==============================================================================

export interface ReviewState {
  required: boolean;
  openIssueCount: number;
  reviewToken?: string;
}

export const reviewStateSchema = z.object({
  required: z.boolean(),
  openIssueCount: z.number().int().nonnegative(),
  reviewToken: z.string().optional(),
});
