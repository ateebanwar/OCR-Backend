/**
 * Model Telemetry & Invocation Tracking Domain Models
 * 
 * Provides an authoritative, single source of truth for all AI model invocations
 * across extraction, retries, candidate fallbacks, escalations, corrections, and verifications.
 */

export type ModelInvocationPurpose =
  | 'EXTRACTION'
  | 'RETRY'
  | 'FALLBACK'
  | 'ESCALATION'
  | 'CORRECTION'
  | 'VERIFICATION'
  | 'CHAT';

export type ModelInvocationOutcome = 'SUCCESS' | 'FAILURE' | 'FALLBACK';

export interface ModelInvocationRecord {
  provider: string;
  model: string;
  tier?: string;
  purpose: ModelInvocationPurpose;
  attempt: number;
  durationMs: number;
  timestamp: string;
  outcome: ModelInvocationOutcome;
  trigger?: string;
  error?: string;
}

export interface ModelTelemetrySummary {
  modelsUsed: string[];
  allInvocations: ModelInvocationRecord[];
  retryCount: number;
  escalationCount: number;
  correctionCount: number;
  fallbackUsed: boolean;
  fallbackModel?: string;
}

/**
 * Request-local tracker for model invocations.
 * Guarantees thread-safety and concurrency isolation in serverless environments.
 */
export class ModelInvocationTracker {
  private invocations: ModelInvocationRecord[] = [];

  public record(record: ModelInvocationRecord): void {
    this.invocations.push({
      ...record,
      timestamp: record.timestamp || new Date().toISOString(),
    });
  }

  public getInvocations(): ModelInvocationRecord[] {
    return [...this.invocations];
  }

  /**
   * Returns list of unique models invoked across all stages in chronological order.
   */
  public getUniqueModels(): string[] {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const inv of this.invocations) {
      if (inv.model && !seen.has(inv.model)) {
        seen.add(inv.model);
        unique.push(inv.model);
      }
    }
    return unique;
  }

  /**
   * Count of repeated attempts on the same model tier due to transient errors.
   */
  public getRetryCount(): number {
    return this.invocations.filter((inv) => inv.purpose === 'RETRY').length;
  }

  /**
   * Count of intentional model tier transitions to a stronger reasoning model.
   */
  public getEscalationCount(): number {
    return this.invocations.filter((inv) => inv.purpose === 'ESCALATION').length;
  }

  /**
   * Count of AI prompt repairs driven by deterministic or semantic discrepancy feedback.
   */
  public getCorrectionCount(): number {
    return this.invocations.filter((inv) => inv.purpose === 'CORRECTION').length;
  }

  /**
   * Identifies whether a provider-level candidate fallback occurred.
   */
  public getFallbackInfo(): { fallbackUsed: boolean; fallbackModel?: string } {
    const fallbackInv = this.invocations.find((inv) => inv.purpose === 'FALLBACK' && inv.outcome === 'SUCCESS');
    if (fallbackInv) {
      return {
        fallbackUsed: true,
        fallbackModel: fallbackInv.model,
      };
    }
    return {
      fallbackUsed: false,
      fallbackModel: undefined,
    };
  }

  public getSummary(): ModelTelemetrySummary {
    const fallbackInfo = this.getFallbackInfo();
    return {
      modelsUsed: this.getUniqueModels(),
      allInvocations: this.getInvocations(),
      retryCount: this.getRetryCount(),
      escalationCount: this.getEscalationCount(),
      correctionCount: this.getCorrectionCount(),
      fallbackUsed: fallbackInfo.fallbackUsed,
      fallbackModel: fallbackInfo.fallbackModel,
    };
  }
}
