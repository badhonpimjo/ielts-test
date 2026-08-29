/**
 * Shared segment and parameter types for IELTS transcription engines.
 */

export interface WhisperSegment {
  t0: number; // seconds
  t1: number; // seconds
  text: string;
}

export interface WhisperParams {
  language?: string;
  translate?: boolean;
  threads?: number;
  startedAt?: number;
}