import { FinancialReconciliationReport } from '../domain/processing';
import { SecondPassVerificationResult } from '../services/VerificationService';
import { CompletenessValidationResult } from './completenessValidator';
import { SemanticValidationResult } from './semanticValidator';
import { XlsxVerificationReport } from '../spreadsheet/xlsxVerifier';

export interface VerificationGateInputs {
  reconciliation: FinancialReconciliationReport;
  secondPass: SecondPassVerificationResult;
  completeness: CompletenessValidationResult;
  semanticValidation: SemanticValidationResult;
  xlsxVerification: XlsxVerificationReport;
}

export interface VerificationGateResult {
  isVerified: boolean;
  reconciliationVerified: boolean;
  secondPassVerified: boolean;
  completenessVerified: boolean;
  semanticVerified: boolean;
  xlsxVerified: boolean;
  gateFailureReasons: string[];
}

/**
 * Final Production Verification Gate
 * 
 * Strict multi-pillar verification aggregator:
 * 1. Deterministic Financial Reconciliation (Authoritative - AI CANNOT override)
 * 2. Independent Second-Pass Source Document Verification
 * 3. Document Coverage & Crucial Field Completeness
 * 4. Semantic Business Logic Validation
 * 5. OpenXML Spreadsheet Integrity & Formula Verification
 */
export function evaluateFinalVerificationGate(
  inputs: VerificationGateInputs
): VerificationGateResult {
  const gateFailureReasons: string[] = [];

  // Pillar 1: Deterministic Financial Reconciliation (AUTHORITATIVE)
  // AI cannot override arithmetic truth under any circumstances.
  const reconciliationVerified =
    inputs.reconciliation.isVerified === true &&
    inputs.reconciliation.overallStatus === 'EXACT_MATCH' &&
    (!inputs.reconciliation.discrepancies || inputs.reconciliation.discrepancies.length === 0);

  if (!reconciliationVerified) {
    gateFailureReasons.push(
      `Deterministic financial reconciliation failed: status='${inputs.reconciliation.overallStatus}', discrepancies=[${(inputs.reconciliation.discrepancies || []).join('; ')}]`
    );
  }

  // Pillar 2: Independent Second-Pass Verification
  const secondPassVerified = inputs.secondPass.isVerified === true;
  if (!secondPassVerified) {
    const issues = inputs.secondPass.issuesFound && inputs.secondPass.issuesFound.length > 0
      ? inputs.secondPass.issuesFound.join('; ')
      : inputs.secondPass.verifierNotes || 'Second-pass audit reported unresolved discrepancies or timed out';
    gateFailureReasons.push(`Second-pass audit verification failed: ${issues}`);
  }

  // Pillar 3: Completeness & Page Coverage
  const completenessVerified = inputs.completeness.isComplete === true;
  if (!completenessVerified) {
    const missing = inputs.completeness.missingCrucialFields.join(', ') || 'incomplete page coverage';
    gateFailureReasons.push(`Document completeness check failed: missing crucial fields [${missing}]`);
  }

  // Pillar 4: Semantic Validation
  const semanticVerified =
    inputs.semanticValidation.isValid === true &&
    (!inputs.semanticValidation.errors || inputs.semanticValidation.errors.length === 0);

  if (!semanticVerified) {
    gateFailureReasons.push(
      `Semantic validation failed: errors=[${(inputs.semanticValidation.errors || []).join('; ')}]`
    );
  }

  // Pillar 5: XLSX Integrity & Formula Safety
  const xlsxVerified =
    inputs.xlsxVerification.isValid === true &&
    (!inputs.xlsxVerification.errors || inputs.xlsxVerification.errors.length === 0);

  if (!xlsxVerified) {
    gateFailureReasons.push(
      `Spreadsheet integrity verification failed: [${(inputs.xlsxVerification.errors || []).join('; ')}]`
    );
  }

  // Final Strict Conjunction: ALL 5 pillars must pass
  const isVerified =
    reconciliationVerified &&
    secondPassVerified &&
    completenessVerified &&
    semanticVerified &&
    xlsxVerified;

  return {
    isVerified,
    reconciliationVerified,
    secondPassVerified,
    completenessVerified,
    semanticVerified,
    xlsxVerified,
    gateFailureReasons,
  };
}
