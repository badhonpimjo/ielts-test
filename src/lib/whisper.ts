/**
 * Shared segment and parameter types for IELTS transcription engines.
 */

export interface WhisperSegment {
  t0: number; // seconds
  t1: number; // seconds
  text: string;
  noSpeechProb?: number;
  avgLogProb?: number;
}

export interface WhisperWord {
  word: string;
  start: number; // seconds
  end: number; // seconds
}

export interface WhisperSilence {
  start: number; // seconds
  end: number; // seconds
  durationMs: number;
  kind: 'leading' | 'internal' | 'trailing';
}

export interface WhisperParams {
  language?: string;
  translate?: boolean;
  threads?: number;
  startedAt?: number;
}

/**
 * Sub-band rationale for a single IELTS criterion. The LLM evaluator returns
 * one of these per axis (fluency, lexical, grammar, pronunciation).
 */
export interface WhisperBandRationale {
  fluencyCoherence: string;
  lexicalResource: string;
  grammaticalRange: string;
  pronunciation: string;
}

export interface WhisperGrammarError {
  category: string;
  quote: string;
  correction: string;
  explanation: string;
}

export interface WhisperAdvancedVocabItem {
  phrase: string;
  level: 'C1' | 'C2' | 'B2';
}

export interface WhisperVocabUpgrade {
  original: string;
  suggestion: string;
  level?: string;
}

export interface WhisperGrammaticalStructure {
  type: string;
  example: string;
}

export interface WhisperBandEvaluation {
  evaluator: string; // e.g. "groq-llm"
  model: string;
  fluencyCoherence: number; // 0..9
  lexicalResource: number;  // 0..9
  grammaticalRange: number; // 0..9
  pronunciation: number | null; // null (text-only scope)
  indicativeBand?: number;  // 0..9, 3-axis indicative band
  overallBand: number;      // 0..9, official IELTS rounded
  rationale: WhisperBandRationale;
  advancedVocabulary?: WhisperAdvancedVocabItem[];
  vocabularyUpgrades?: WhisperVocabUpgrade[];
  grammarErrors?: WhisperGrammarError[];
  grammaticalStructuresUsed?: WhisperGrammaticalStructure[];
  topThreeImprovements: string[];
  latencyMs: number;
}

/** Mirrors the deterministic v1 scorer (always present, may be null on tiny clips). */
export interface WhisperDeterministicScore {
  band: number;
  pronunciationScore: number | null;
  components: {
    rateBand: number;
    pausePenalty: number;
    lexicalBonus: number;
  };
  features: {
    wpm: number;
    typeTokenRatio: number;
    avgWordLength: number;
    discourseMarkersPerMin: number;
    fillerDensityPer100: number;
    longPauseCount: number;
    longestPauseSec: number;
    trailingSilenceSec: number;
    silenceRatio: number;
    avgSentenceLength: number;
    complexStructuresPerMin: number;
    totalLongPauseSec: number;
  };
}