import type {
  WhisperBandEvaluation,
  WhisperDeterministicScore,
  WhisperSegment,
  WhisperSilence,
  WhisperWord,
} from './whisper';

export interface TranscribeOptions {
  startedAt?: number;
  question?: string;
  part?: 1 | 2 | 3;
}

export interface ITranscriber {
  load(onProgress?: (msg: string) => void): Promise<void>;
  transcribe(pcm: Float32Array, options?: TranscribeOptions): Promise<WhisperSegment[]>;
  dispose?(): void;
}

export class ServerTranscriber implements ITranscriber {
  private isReady = false;
  /** Engine used by the most recent transcribe() call. Set after each response. */
  public lastEngineUsed: string | null = null;
  /** Model reported by the most recent transcribe() call. */
  public lastModelUsed: string | null = null;
  /** Latency reported by the most recent transcribe() call (ms). */
  public lastLatencyMs: number | null = null;
  /** Words reported by the most recent transcribe() call. */
  public lastWords: WhisperWord[] = [];
  /** Silences reported by the most recent transcribe() call. */
  public lastSilences: WhisperSilence[] = [];
  /** Audio duration in seconds (server-measured) from the most recent call. */
  public lastAudioDurationSec: number | null = null;
  /** Speech duration in seconds (audio minus leading+trailing silence). */
  public lastSpeechDurationSec: number | null = null;
  /** Fraction of the clip that was silence (0..1). */
  public lastSilenceRatio: number | null = null;
  /** Deterministic v1 score (always present on successful response, may be null on tiny clips). */
  public lastScore: WhisperDeterministicScore | null = null;
  /** LLM-based band evaluation. Null when GROQ_LLM_ENABLED=0 or the LLM call failed. */
  public lastBand: WhisperBandEvaluation | null = null;

  constructor(
    private readonly serverUrl: string = '/api',
    private readonly model: 'base' = 'base',
  ) {}

  /**
   * Check if backend server is online and pre-warmed.
   * Errors now bubble up to the caller so the UI can show them.
   */
  async load(onProgress?: (msg: string) => void): Promise<void> {
    if (this.isReady) return;
    onProgress?.(`Connecting to Backend Whisper Server (${this.model.toUpperCase()})...`);

    let res: Response;
    try {
      res = await fetch(`${this.serverUrl}/health?model=${this.model}`);
    } catch (err) {
      const pageIsHttps =
        typeof window !== 'undefined' && window.location?.protocol === 'https:';
      const backendIsHttp = this.serverUrl.startsWith('http://');
      const hint = pageIsHttps && backendIsHttp
        ? `Browsers block HTTPS pages from calling plain HTTP backends. ` +
          `Fix: either put the API behind HTTPS, or proxy /api/* ` +
          `from the frontend host to the backend.`
        : (err as Error).message;
      throw new Error(
        `Cannot reach backend at ${this.serverUrl}: ${hint}`,
      );
    }

    if (!res.ok) {
      throw new Error(`Backend returned ${res.status} from /health.`);
    }

    const data = (await res.json()) as { isReady?: boolean; status?: string; model?: string };
    if (data.isReady) {
      onProgress?.(`Backend Whisper ${this.model.toUpperCase()} ready.`);
    } else {
      onProgress?.(`Warming up Backend Whisper ${this.model.toUpperCase()}...`);
    }
    this.isReady = true;
  }

  /**
   * Send mono 16 kHz Float32 PCM audio to backend server for transcription.
   */
  async transcribe(pcm: Float32Array, options?: TranscribeOptions): Promise<WhisperSegment[]> {
    if (!this.isReady) {
      await this.load();
    }

    // Convert Float32Array PCM into binary Blob with zero-copy buffer slicing.
    const rawBuffer =
      pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength
        ? (pcm.buffer as ArrayBuffer)
        : (pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer);
    const blob = new Blob([rawBuffer], { type: 'application/octet-stream' });
    const formData = new FormData();
    formData.append('audio', blob, 'audio.pcm');

    const params = new URLSearchParams({ model: this.model });
    if (options?.question) params.set('question', options.question);
    if (options?.part) params.set('part', String(options.part));

    let res: Response;
    try {
      res = await fetch(`${this.serverUrl}/transcribe?${params.toString()}`, {
        method: 'POST',
        body: formData,
      });
    } catch (err) {
      throw new Error(`Transcribe request failed: ${(err as Error).message}`);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let errorMsg = `Server error ${res.status}`;
      try {
        const errJson = JSON.parse(errText);
        if (errJson.error) errorMsg = errJson.error;
      } catch {
        if (errText) errorMsg = `HTTP ${res.status}: ${errText.substring(0, 80)}`;
      }
      throw new Error(errorMsg);
    }

    const data = (await res.json()) as {
      success: boolean;
      engineUsed?: string;
      model?: string;
      latencyMs?: number;
      audioDurationSec?: number;
      speechDurationSec?: number;
      silenceRatio?: number;
      segments: WhisperSegment[];
      words?: WhisperWord[];
      silences?: WhisperSilence[];
      score?: WhisperDeterministicScore | null;
      band?: WhisperBandEvaluation | null;
      error?: string;
    };

    if (!data.success) {
      throw new Error(data.error || 'Server transcription failed');
    }

    this.lastEngineUsed = data.engineUsed ?? null;
    this.lastModelUsed = data.model ?? null;
    this.lastLatencyMs = typeof data.latencyMs === 'number' ? data.latencyMs : null;
    this.lastWords = Array.isArray(data.words) ? data.words : [];
    this.lastSilences = Array.isArray(data.silences) ? data.silences : [];
    this.lastAudioDurationSec = typeof data.audioDurationSec === 'number' ? data.audioDurationSec : null;
    this.lastSpeechDurationSec = typeof data.speechDurationSec === 'number' ? data.speechDurationSec : null;
    this.lastSilenceRatio = typeof data.silenceRatio === 'number' ? data.silenceRatio : null;
    this.lastScore = data.score ?? null;
    this.lastBand = data.band ?? null;

    return data.segments || [];
  }

  dispose(): void {
    this.isReady = false;
  }
}
