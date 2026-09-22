import { getConfig } from './env';
import { DocumentComplexityLevel } from '../domain/processing';

export interface ModelHierarchy {
  primary: string;
  complex: string;
  escalation: string;
}

export function getModelHierarchy(): ModelHierarchy {
  const config = getConfig();
  return {
    primary: config.gemini.extractionModel,
    complex: config.gemini.complexExtractionModel,
    escalation: config.gemini.complexExtractionModel,
  };
}

export function selectModelForComplexity(level: DocumentComplexityLevel): string {
  const hierarchy = getModelHierarchy();
  switch (level) {
    case 'LEVEL_1_SIMPLE':
      return hierarchy.primary;
    case 'LEVEL_2_COMPLEX':
      return hierarchy.complex;
    case 'LEVEL_3_AMBIGUOUS':
      return hierarchy.escalation;
    default:
      return hierarchy.primary;
  }
}

export function getEscalationModel(currentLevel: number): string {
  const hierarchy = getModelHierarchy();
  if (currentLevel >= 2) {
    return hierarchy.escalation;
  }
  return hierarchy.complex;
}
