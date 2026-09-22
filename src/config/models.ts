import {
  getConfig,
  DEFAULT_TIER1_MODEL,
  DEFAULT_TIER2_MODEL,
  DEFAULT_TIER3_MODEL,
  DEFAULT_VERIFICATION_MODEL,
  DEFAULT_CHAT_MODEL,
} from './env';
import { DocumentComplexityLevel } from '../domain/processing';

export interface ModelHierarchy {
  tier1Simple: string;
  tier2Complex: string;
  tier3Escalation: string;
  verification: string;
  chat: string;
  // Aliases for backward compatibility
  primary: string;
  complex: string;
  escalation: string;
}

export function getModelHierarchy(): ModelHierarchy {
  const config = getConfig();
  const tier1Simple = (config.gemini.extractionModel && config.gemini.extractionModel.trim()) || DEFAULT_TIER1_MODEL;
  const tier2Complex = (config.gemini.complexExtractionModel && config.gemini.complexExtractionModel.trim()) || DEFAULT_TIER2_MODEL;
  const tier3Escalation = (config.gemini.escalationModel && config.gemini.escalationModel.trim()) || DEFAULT_TIER3_MODEL;
  const verification = (config.gemini.verificationModel && config.gemini.verificationModel.trim()) || DEFAULT_VERIFICATION_MODEL;
  const chat = (config.gemini.chatModel && config.gemini.chatModel.trim()) || DEFAULT_CHAT_MODEL;

  return {
    tier1Simple,
    tier2Complex,
    tier3Escalation,
    verification,
    chat,
    primary: tier1Simple,
    complex: tier2Complex,
    escalation: tier3Escalation,
  };
}

export function selectModelForComplexity(level: DocumentComplexityLevel): string {
  const hierarchy = getModelHierarchy();
  switch (level) {
    case 'LEVEL_1_SIMPLE':
      return hierarchy.tier1Simple;
    case 'LEVEL_2_COMPLEX':
      return hierarchy.tier2Complex;
    case 'LEVEL_3_AMBIGUOUS':
      return hierarchy.tier3Escalation;
    default:
      return hierarchy.tier1Simple;
  }
}

export function getEscalationModel(currentLevel: number): string {
  const hierarchy = getModelHierarchy();
  if (currentLevel >= 2) {
    return hierarchy.tier3Escalation;
  }
  return hierarchy.tier2Complex;
}

export function getVerificationModel(): string {
  const hierarchy = getModelHierarchy();
  return hierarchy.verification;
}
