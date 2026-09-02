import './app.css';
import { AudioRecorder, decodeFileToPcm } from './lib/audio';
import type { WhisperSegment, WhisperParams } from './lib/whisper';
import { ServerTranscriber } from './lib/server-transcriber';

interface DisplaySegment extends WhisperSegment {
  id: number;
}

export interface ITranscriber {
  load(onProgress?: (msg: string) => void): Promise<void>;
  transcribe(
    pcm: Float32Array,
    options?: WhisperParams | { startedAt?: number; question?: string; part?: 1 | 2 | 3; [key: string]: unknown },
  ): Promise<WhisperSegment[]>;
  dispose?(): void;
}

export class App {
  private recorder: AudioRecorder | null = null;
  private transcriber: ITranscriber | null = null;
  private activeEngineKey = '';

  private lastPcm: Float32Array | null = null;
  private lastAudioDuration = 0;

  private segments: DisplaySegment[] = [];
  private nextId = 1;
  private recording = false;
  private recordStartTime = 0;
  private timerInterval: number | null = null;
  private status = 'Connecting to server…';

  constructor(private readonly root: HTMLElement) {
    this.render();
    void this.initServerEngine();
  }

  private render(): void {
    this.root.innerHTML = `
      <header class="hdr">
        <div class="hdr-top">
          <div>
            <h1>IELTS Audio-to-Text POC</h1>
            <p class="sub">High-performance speech-to-text and IELTS Band Score evaluation powered by Whisper &amp; LLM.</p>
          </div>
          <div id="device-badge" class="device-badge">Detecting hardware…</div>
        </div>
      </header>

      <section class="card engine-card">
        <div class="engine-selector-group">
          <label for="engine-select" class="engine-label">🧠 AI Engine &amp; Model:</label>
          <select id="engine-select" class="engine-select">
            <option value="server-base" selected>⚡ Server (Groq Whisper Turbo) — Fast Real-Time &amp; High Accuracy</option>
          </select>
        </div>
        <div id="engine-info" class="engine-info">🚀 Server Backend via Groq Whisper Turbo (0 MB client download, ultra-fast real-time transcription).</div>
      </section>

      <section class="card prompt-card">
        <div class="prompt-header">
          <span class="prompt-icon">📝</span>
          <span class="section-label">IELTS Speaking Prompt / Question (Optional)</span>
        </div>
        <div class="prompt-inputs">
          <select id="part-select" class="part-select">
            <option value="" selected>— select part —</option>
            <option value="1">Part 1 · Short Q&amp;A (≤ 45s)</option>
            <option value="2">Part 2 · Cue Card / Long Turn (60–120s)</option>
            <option value="3">Part 3 · Discussion (30–60s per answer)</option>
          </select>
          <input type="text" id="question-input" class="question-input" placeholder="e.g. Describe a difficult problem you solved..." />
        </div>
      </section>

      <section class="card mode-card">
        <div class="controls-primary">
          <button id="record-btn" class="btn-record">
            <span class="rec-dot"></span>
            <span id="record-btn-text">Record Audio</span>
          </button>
          <input id="file" type="file" accept="audio/*" hidden />
          <button id="upload" class="secondary">📁 Upload audio file…</button>
        </div>

        <div class="controls-secondary">
          <button id="clear" class="ghost" disabled>Clear transcript</button>
          <button id="copy" class="ghost" disabled>Copy all</button>
        </div>
      </section>

      <section class="card audio-preview-card" id="audio-preview-container" style="display: none;">
        <div class="audio-preview-header">
          <div class="audio-preview-title">
            <span class="audio-icon">🎧</span>
            <span id="audio-preview-label" class="section-label">Recorded Audio:</span>
          </div>
          <div class="audio-preview-actions">
            <button id="transcribe-audio-btn" class="btn-transcribe-main">
              ⚡ Transcribe Audio
            </button>
            <button id="delete-audio-btn" class="btn-delete-audio" title="Delete this audio">
              🗑️ Delete
            </button>
          </div>
        </div>
        <audio id="audio-preview" controls></audio>
      </section>

      <section class="meter-row card">
        <div class="meter-info">
          <label>Audio Level:</label>
          <div class="meter"><div id="level" class="level"></div></div>
        </div>
        <div class="status-box">
          <span id="timer" class="timer" style="display: none;">00:00</span>
          <span id="status" class="status">${this.escape(this.status)}</span>
        </div>
      </section>

      <section class="transcript card" id="transcript" aria-live="polite">
        <p class="empty">No transcript yet. Choose an engine and record or upload audio.</p>
      </section>

      <section class="card pause-summary-card" id="pause-summary-container" style="display: none;">
        <div class="pause-summary-header">
          <span class="pause-icon">⏸️</span>
          <span class="section-label">Pause Analysis</span>
        </div>
        <div id="pause-summary" class="pause-summary"></div>
      </section>

      <section class="card band-card" id="band-container" style="display: none;">
        <div class="band-card-header">
          <span class="band-icon">🎯</span>
          <span class="section-label">IELTS Band Score</span>
          <span id="band-evaluator" class="band-evaluator-tag"></span>
        </div>
        <div id="band-summary" class="band-summary"></div>
        <div id="band-details" class="band-details"></div>
      </section>

      <footer class="ftr">
        <span id="footer-text">Speech is processed privately and securely.</span>
      </footer>
    `;

    // Bind event listeners
    this.root.querySelector('#engine-select')!.addEventListener('change', (e) => {
      this.switchEngine((e.target as HTMLSelectElement).value);
    });
    this.root.querySelector('#record-btn')!.addEventListener('click', () => this.toggleRecording());
    this.root.querySelector('#upload')!.addEventListener('click', () =>
      this.root.querySelector<HTMLInputElement>('#file')!.click(),
    );
    this.root.querySelector('#file')!.addEventListener('change', (e) =>
      this.handleFile((e.target as HTMLInputElement).files?.[0]),
    );
    this.root.querySelector('#clear')!.addEventListener('click', () => this.clear());
    this.root.querySelector('#copy')!.addEventListener('click', () => this.copyAll());
    this.root.querySelector('#transcribe-audio-btn')!.addEventListener('click', () => this.transcribeCurrentAudio());
    this.root.querySelector('#delete-audio-btn')!.addEventListener('click', () => this.deleteCurrentAudio());
  }

  private async initServerEngine(): Promise<void> {
    const badge = this.root.querySelector<HTMLElement>('#device-badge')!;
    const select = this.root.querySelector<HTMLSelectElement>('#engine-select')!;
    const apiBase = '/api';

    try {
      const serverRes = await fetch(`${apiBase}/health`);
      if (serverRes.ok) {
        badge.className = 'device-badge badge-webgpu';
        badge.textContent = '🚀 Backend Server Active';
        select.value = 'server-base';
        this.switchEngine('server-base');
        this.setStatus('Ready. Choose an option to start.');
        return;
      }
      badge.textContent = '⚠️ Backend not reachable';
    } catch {
      badge.textContent = '⚠️ Backend not reachable';
    }
    this.setStatus('Server unavailable. Start the backend to enable transcription.');
  }

  private switchEngine(engineKey: string): void {
    if (this.activeEngineKey === engineKey && this.transcriber) return;
    this.transcriber?.dispose?.();

    this.activeEngineKey = engineKey;
    const infoEl = this.root.querySelector<HTMLElement>('#engine-info');
    const apiBase = '/api';

    this.transcriber = new ServerTranscriber(apiBase, 'base');
    if (infoEl) infoEl.textContent = '🚀 Server Backend via Groq Whisper Turbo (0 MB client download, ultra-fast real-time transcription).';

    if (this.lastPcm) {
      this.setStatus(`Switched engine to ${engineKey}. Audio ready—click "⚡ Transcribe Audio" to run with this model.`);
    } else {
      this.setStatus(`Engine switched to ${engineKey}.`);
    }
  }

  private setStatus(msg: string): void {
    this.status = msg;
    const el = this.root.querySelector('#status');
    if (el) el.textContent = msg;
  }

  private setLevel(level: number): void {
    const el = this.root.querySelector<HTMLDivElement>('#level');
    if (el) el.style.width = `${Math.round(level * 100)}%`;
  }

  /**
   * Mode 1: Full Recording (Record entire speech -> Stop -> Transcribe whole audio)
   */
  private async toggleRecording(): Promise<void> {
    if (this.recording) {
      await this.stopRecordingAndTranscribe();
    } else {
      await this.startRecording();
    }
  }

  private async startRecording(): Promise<void> {
    this.setStatus('Initializing microphone…');
    this.recorder = new AudioRecorder((lvl) => this.setLevel(lvl));

    try {
      await this.recorder.start();
    } catch (err) {
      this.setStatus(`Mic error: ${(err as Error).message}`);
      return;
    }

    this.recording = true;
    this.recordStartTime = Date.now();
    this.updateRecordingUI(true);
    this.setStatus('Recording audio… Speak now.');

    void this.transcriber?.load();

    const timerEl = this.root.querySelector<HTMLElement>('#timer')!;
    timerEl.style.display = 'inline-block';
    timerEl.textContent = '00:00';

    this.timerInterval = window.setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - this.recordStartTime) / 1000);
      const m = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
      const s = String(elapsedSec % 60).padStart(2, '0');
      timerEl.textContent = `${m}:${s}`;
    }, 500);
  }

  private async stopRecordingAndTranscribe(): Promise<void> {
    if (!this.recorder || !this.recording) return;

    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }

    this.recording = false;
    this.updateRecordingUI(false);
    this.setStatus('Processing recording…');
    const result = await this.recorder.stop();
    this.recorder = null;

    const container = this.root.querySelector<HTMLElement>('#audio-preview-container')!;
    const audioEl = this.root.querySelector<HTMLAudioElement>('#audio-preview')!;
    audioEl.src = result.audioUrl;
    container.style.display = 'block';

    if (result.durationSeconds < 0.3) {
      this.setStatus('Recording was too short. Speak longer.');
      return;
    }

    this.lastPcm = result.pcm;
    this.lastAudioDuration = result.durationSeconds;

    const labelEl = this.root.querySelector<HTMLElement>('#audio-preview-label');
    if (labelEl) labelEl.textContent = `🎧 Recorded Audio (${result.durationSeconds.toFixed(1)}s):`;

    // Auto-detect IELTS part from duration — ONLY Part 2 has a distinctive signature.
    // Part 1 (15–45s) and Part 3 (30–60s) overlap completely and cannot be told apart
    // by duration alone. We only auto-select Part 2 (60–150s monologue). For everything
    // else, default to Part 1 as the most common single-answer recording, but show a
    // reminder so the user can correct it if needed.
    const partSelect = this.root.querySelector<HTMLSelectElement>('#part-select');
    if (partSelect && !partSelect.value) {
      const dur = result.durationSeconds;
      if (dur >= 55 && dur <= 150) {
        // Part 2 is the only part reliably identifiable by duration
        partSelect.value = '2';
        this.setStatus(`Audio recorded (${dur.toFixed(1)}s) — looks like Part 2 (Long Turn). Sending for evaluation… ✏️ Change part if needed.`);
      } else {
        // Part 1 and Part 3 are indistinguishable by time — default Part 1, user must correct for Part 3
        partSelect.value = '1';
        this.setStatus(`Audio recorded (${dur.toFixed(1)}s) — defaulted to Part 1. ✏️ Change to Part 3 if this is a discussion answer.`);
      }
    } else {
      this.setStatus(`Audio recorded (${result.durationSeconds.toFixed(1)}s). Sending for evaluation…`);
    }

    // Auto-transcribe immediately — no need to click "Transcribe Audio"
    await this.transcribeCurrentAudio();
  }

  /**
   * Explicitly transcribe the current audio with whichever engine is selected
   */
  private async transcribeCurrentAudio(): Promise<void> {
    if (!this.lastPcm) {
      this.setStatus('No audio recorded yet. Please record or upload audio first.');
      return;
    }

    const btn = this.root.querySelector<HTMLButtonElement>('#transcribe-audio-btn');
    if (btn) btn.disabled = true;

    this.setStatus(`Transcribing ${this.lastAudioDuration.toFixed(1)}s with current engine…`);

    const questionInput = this.root.querySelector<HTMLInputElement>('#question-input');
    const partSelect = this.root.querySelector<HTMLSelectElement>('#part-select');
    const question = questionInput?.value.trim() || undefined;
    let partVal = partSelect?.value ? Number(partSelect.value) as 1 | 2 | 3 : undefined;

    // Auto-suggest: if audio > 60s but Part 1 selected, upgrade to Part 2 and warn
    if (this.lastAudioDuration > 60 && partVal === 1) {
      partVal = 2;
      if (partSelect) partSelect.value = '2';
      this.setStatus('⚠️ Audio is >60s — auto-switched to Part 2 (Long Turn) for accurate scoring.');
      await new Promise(r => setTimeout(r, 1800));
    }
    const part = partVal;

    try {
      if (!this.transcriber) {
        this.setStatus('No engine selected yet.');
        return;
      }
      await this.transcriber.load((m) => this.setStatus(m));
      const t0 = performance.now();
      const segs = await this.transcriber.transcribe(this.lastPcm, { question, part });
      const latencyMs = Math.round(performance.now() - t0);
      const speedFactor = this.lastAudioDuration / Math.max(0.01, latencyMs / 1000);
      this.appendSegments(segs);

      let engineLabel = '';
      if (this.transcriber instanceof ServerTranscriber) {
        const st = this.transcriber as ServerTranscriber;
        if (st.lastEngineUsed) engineLabel = ` via ${st.lastEngineUsed}`;
        if (st.lastLatencyMs !== null) engineLabel += ` (server ${st.lastLatencyMs}ms)`;
      }
      this.setStatus(`Done: ${segs.length} segments in ${(latencyMs / 1000).toFixed(2)}s (${speedFactor.toFixed(1)}x Real-Time Speed)${engineLabel}.`);

      if (this.transcriber instanceof ServerTranscriber) {
        const st = this.transcriber as ServerTranscriber;
        if (st.lastSilences.length > 0) {
          this.renderPauseSummary(st);
        } else {
          this.clearPauseSummary();
        }

        if (st.lastBand) {
          this.renderBandSummary(st, 'llm');
        } else if (st.lastScore) {
          this.renderBandSummary(st, 'v1');
        } else {
          this.clearBandSummary();
        }
      }
    } catch (err) {
      this.setStatus(`Transcription failed: ${(err as Error).message}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  private deleteCurrentAudio(): void {
    this.lastPcm = null;
    this.lastAudioDuration = 0;

    const container = this.root.querySelector<HTMLElement>('#audio-preview-container');
    const audioEl = this.root.querySelector<HTMLAudioElement>('#audio-preview');
    if (audioEl) {
      audioEl.pause();
      audioEl.src = '';
    }
    if (container) container.style.display = 'none';

    this.setStatus('Audio deleted. Record or upload new audio.');
  }

  private updateRecordingUI(isRecording: boolean): void {
    const btn = this.root.querySelector<HTMLButtonElement>('#record-btn')!;
    const text = this.root.querySelector<HTMLElement>('#record-btn-text')!;
    const uploadBtn = this.root.querySelector<HTMLButtonElement>('#upload')!;
    const engineSelect = this.root.querySelector<HTMLSelectElement>('#engine-select')!;
    const transcribeBtn = this.root.querySelector<HTMLButtonElement>('#transcribe-audio-btn');

    if (isRecording) {
      btn.classList.add('recording');
      text.textContent = 'Stop Recording';
      uploadBtn.disabled = true;
      engineSelect.disabled = true;
      if (transcribeBtn) transcribeBtn.disabled = true;
    } else {
      btn.classList.remove('recording');
      text.textContent = 'Record Audio';
      uploadBtn.disabled = false;
      engineSelect.disabled = false;
      if (transcribeBtn) transcribeBtn.disabled = false;
    }
  }

  private async handleFile(file: File | undefined): Promise<void> {
    if (!file) return;
    this.setStatus(`Decoding ${file.name}…`);

    const container = this.root.querySelector<HTMLElement>('#audio-preview-container')!;
    const audioEl = this.root.querySelector<HTMLAudioElement>('#audio-preview')!;
    audioEl.src = URL.createObjectURL(file);
    container.style.display = 'block';

    try {
      const pcm = await decodeFileToPcm(file);
      this.lastPcm = pcm;
      this.lastAudioDuration = pcm.length / 16000;

      const labelEl = this.root.querySelector<HTMLElement>('#audio-preview-label');
      if (labelEl) labelEl.textContent = `📁 ${file.name} (${this.lastAudioDuration.toFixed(1)}s):`;

      this.setStatus(`File decoded (${this.lastAudioDuration.toFixed(1)}s). Select your model and click "Transcribe Audio".`);
    } catch (err) {
      this.setStatus(`Failed to decode audio: ${(err as Error).message}`);
    }
  }

  private appendSegments(segs: WhisperSegment[]): void {
    for (const s of segs) {
      const clean = s.text.replace(/\[BLANK_AUDIO\]/g, '').trim();
      if (!clean) continue;
      this.segments.push({ ...s, text: clean, id: this.nextId++ });
    }
    this.renderTranscript();
    (this.root.querySelector('#clear') as HTMLButtonElement).disabled = this.segments.length === 0;
    (this.root.querySelector('#copy') as HTMLButtonElement).disabled = this.segments.length === 0;
  }

  private renderPauseSummary(st: ServerTranscriber): void {
    const container = this.root.querySelector<HTMLElement>('#pause-summary-container');
    const body = this.root.querySelector<HTMLElement>('#pause-summary');
    if (!container || !body) return;

    const internal = st.lastSilences.filter((s) => s.kind === 'internal');
    const trailing = st.lastSilences.find((s) => s.kind === 'trailing');
    const longest = internal.reduce<{ ms: number; at: number } | null>(
      (acc, s) => (acc === null || s.durationMs > acc.ms ? { ms: s.durationMs, at: s.start } : acc),
      null,
    );
    const longPauses = internal.filter((s) => s.durationMs >= 2000);

    const pct = (st.lastSilenceRatio ?? 0) * 100;
    const fmtSec = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;
    const fmtT = (sec: number): string => `${sec.toFixed(2)}s`;

    const overallClass = pct >= 35 ? 'pause-overall high' : pct >= 15 ? 'pause-overall medium' : 'pause-overall low';

    const internalRows = internal.length === 0
      ? '<div class="pause-empty">No significant internal pauses.</div>'
      : internal
          .sort((a, b) => a.start - b.start)
          .map((s) => {
            const cls = s.durationMs >= 4000
              ? 'pause-row very-long'
              : s.durationMs >= 2000
                ? 'pause-row long'
                : 'pause-row short';
            return `
              <div class="${cls}">
                <span class="pause-when">${fmtT(s.start)}–${fmtT(s.end)}</span>
                <span class="pause-dur">${fmtSec(s.durationMs)}</span>
                <span class="pause-badge">${s.durationMs >= 4000 ? 'long hesitation' : s.durationMs >= 2000 ? 'notable' : 'minor'}</span>
              </div>`;
          })
          .join('');

    body.innerHTML = `
      <div class="pause-stats">
        <div class="pause-stat"><span class="num">${st.lastSilences.length}</span><span class="lbl">total pauses</span></div>
        <div class="pause-stat"><span class="num">${longPauses.length}</span><span class="lbl">long (≥2s)</span></div>
        <div class="pause-stat"><span class="num">${longest ? fmtSec(longest.ms) : '—'}</span><span class="lbl">longest</span></div>
        <div class="pause-stat"><span class="num">${st.lastSpeechDurationSec !== null ? fmtT(st.lastSpeechDurationSec) : '—'}</span><span class="lbl">speech time</span></div>
        <div class="${overallClass}"><span class="num">${pct.toFixed(0)}%</span><span class="lbl">silence ratio</span></div>
      </div>
      ${trailing && trailing.durationMs >= 1500
        ? `<div class="pause-trailing">⏹ Trailing silence: <b>${fmtSec(trailing.durationMs)}</b> before stop clicked (excluded from scoring).</div>`
        : ''}
      <div class="pause-list">${internalRows}</div>
    `;
    container.style.display = 'block';
  }

  private clearPauseSummary(): void {
    const container = this.root.querySelector<HTMLElement>('#pause-summary-container');
    if (container) container.style.display = 'none';
  }

  private bandColorClass(band: number): string {
    if (band >= 8) return 'band-excellent';
    if (band >= 7) return 'band-good';
    if (band >= 6) return 'band-competent';
    if (band >= 5) return 'band-modest';
    if (band >= 4) return 'band-limited';
    return 'band-low';
  }

  private renderBandSummary(
    st: ServerTranscriber,
    source: 'llm' | 'v1',
  ): void {
    const container = this.root.querySelector<HTMLElement>('#band-container');
    const summaryEl = this.root.querySelector<HTMLElement>('#band-summary');
    const detailsEl = this.root.querySelector<HTMLElement>('#band-details');
    const tagEl = this.root.querySelector<HTMLElement>('#band-evaluator');
    if (!container || !summaryEl || !detailsEl || !tagEl) return;

    const band = st.lastBand;
    const score = st.lastScore;
    const overall = band?.overallBand ?? score?.band ?? 0;
    const bandClass = this.bandColorClass(overall);
    const fmtBand = (n: number | null | undefined): string =>
      typeof n === 'number' ? n.toFixed(1) : '—';

    tagEl.textContent = source === 'llm'
      ? `LLM · ${band?.model ?? 'groq-llm'}`
      : 'Deterministic v1 (LLM disabled)';

    summaryEl.innerHTML = `
      <div class="band-pill ${bandClass}">
        <div class="band-num">${overall.toFixed(1)}</div>
        <div class="band-scale">/ 9.0 (Official Rounding)</div>
      </div>
      <div class="band-meta">
        <div class="band-meta-row">
          <span class="lbl">Fluency &amp; Coherence</span>
          <span class="val">${fmtBand(band?.fluencyCoherence ?? score?.components.rateBand)}</span>
        </div>
        <div class="band-meta-row">
          <span class="lbl">Lexical Resource</span>
          <span class="val">${fmtBand(band?.lexicalResource)}</span>
        </div>
        <div class="band-meta-row">
          <span class="lbl">Grammatical Range</span>
          <span class="val">${fmtBand(band?.grammaticalRange)}</span>
        </div>
        <div class="band-meta-row sub-excluded">
          <span class="lbl">Pronunciation</span>
          <span class="val">Excluded in v1</span>
        </div>
      </div>
    `;

    if (source === 'llm' && band) {
      const r = band.rationale;
      const improvements = band.topThreeImprovements
        .map((tip) => `<li>${this.escape(tip)}</li>`)
        .join('');

      let grammarHtml = '';
      if (Array.isArray(band.grammarErrors) && band.grammarErrors.length > 0) {
        grammarHtml = `
          <div class="band-section">
            <div class="band-section-title">Grammar Diagnostics (${band.grammarErrors.length} detected)</div>
            <div class="grammar-errors-list">
              ${band.grammarErrors
                .map(
                  (err) => `
                <div class="grammar-error-card">
                  <div class="grammar-error-header">
                    <span class="grammar-badge">${this.escape(err.category)}</span>
                  </div>
                  <div class="grammar-error-diff">
                    <span class="grammar-wrong">${this.escape(err.quote)}</span>
                    <span class="grammar-arrow">➔</span>
                    <span class="grammar-right">${this.escape(err.correction)}</span>
                  </div>
                  <div class="grammar-error-exp">${this.escape(err.explanation)}</div>
                </div>`,
                )
                .join('')}
            </div>
          </div>
        `;
      }

      let vocabHtml = '';
      if (Array.isArray(band.advancedVocabulary) && band.advancedVocabulary.length > 0) {
        vocabHtml = `
          <div class="band-section">
            <div class="band-section-title">Advanced Vocabulary &amp; Collocations (C1/C2)</div>
            <div class="vocab-chips">
              ${band.advancedVocabulary
                .map(
                  (v) => `
                <span class="chip-vocab ${v.level === 'C2' ? 'chip-c2' : v.level === 'B2' ? 'chip-b2' : 'chip-c1'}">
                  <span class="vocab-lvl">${this.escape(v.level)}</span>
                  <span class="vocab-text">${this.escape(v.phrase)}</span>
                </span>`,
                )
                .join('')}
            </div>
          </div>
        `;
      }

      let upgradeHtml = '';
      if (Array.isArray(band.vocabularyUpgrades) && band.vocabularyUpgrades.length > 0) {
        upgradeHtml = `
          <div class="band-section">
            <div class="band-section-title">Vocabulary Upgrades</div>
            <div class="vocab-upgrades-list">
              ${band.vocabularyUpgrades
                .map(
                  (u) => `
                <div class="upgrade-row">
                  <span class="upgrade-orig">${this.escape(u.original)}</span>
                  <span class="upgrade-arrow">➔</span>
                  <span class="upgrade-sug">${this.escape(u.suggestion)}</span>
                  ${u.level ? `<span class="upgrade-lvl">${this.escape(u.level)}</span>` : ''}
                </div>`,
                )
                .join('')}
            </div>
          </div>
        `;
      }

      detailsEl.innerHTML = `
        <div class="band-section">
          <div class="band-section-title">Examiner Feedback</div>
          <div class="band-rationale"><b>Fluency &amp; Coherence:</b> ${this.escape(r.fluencyCoherence)}</div>
          <div class="band-rationale"><b>Lexical Resource:</b> ${this.escape(r.lexicalResource)}</div>
          <div class="band-rationale"><b>Grammatical Range:</b> ${this.escape(r.grammaticalRange)}</div>
        </div>
        ${grammarHtml}
        ${vocabHtml}
        ${upgradeHtml}
        <div class="band-section">
          <div class="band-section-title">Top 3 Improvements</div>
          <ol class="band-improvements">${improvements}</ol>
        </div>
        <div class="band-foot">LLM evaluator latency: ${band.latencyMs}ms · model ${this.escape(band.model)}</div>
      `;
    } else if (score) {
      const f = score.features;
      detailsEl.innerHTML = `
        <div class="band-section">
          <div class="band-section-title">Deterministic v1 components</div>
          <div class="band-features">
            <span class="chip">WPM <b>${f.wpm}</b></span>
            <span class="chip">TTR <b>${(f.typeTokenRatio * 100).toFixed(0)}%</b></span>
            <span class="chip">avg word <b>${f.avgWordLength}</b></span>
            <span class="chip">long pauses <b>${f.longPauseCount}</b></span>
            <span class="chip">longest <b>${f.longestPauseSec.toFixed(2)}s</b></span>
            <span class="chip">silence <b>${(f.silenceRatio * 100).toFixed(0)}%</b></span>
          </div>
        </div>
        <div class="band-foot">Enable GROQ_LLM_ENABLED=1 on the backend for full sub-axis evaluation.</div>
      `;
    } else {
      detailsEl.innerHTML = '';
    }

    container.style.display = 'block';
  }

  private clearBandSummary(): void {
    const container = this.root.querySelector<HTMLElement>('#band-container');
    if (container) container.style.display = 'none';
  }

  private renderTranscript(): void {
    const pane = this.root.querySelector<HTMLElement>('#transcript')!;
    if (this.segments.length === 0) {
      pane.innerHTML = `<p class="empty">No transcript yet. Choose an engine and record or upload audio.</p>`;
      return;
    }
    pane.innerHTML = this.segments
      .map(
        (s) => `
        <div class="seg" data-id="${s.id}">
          <span class="ts">[${s.t0.toFixed(1)}–${s.t1.toFixed(1)}s]</span>
          <span class="txt">${this.escape(s.text)}</span>
        </div>`,
      )
      .join('');
    pane.scrollTop = pane.scrollHeight;
  }

  private clear(): void {
    this.segments = [];
    this.renderTranscript();
    (this.root.querySelector('#clear') as HTMLButtonElement).disabled = true;
    (this.root.querySelector('#copy') as HTMLButtonElement).disabled = true;
    this.setStatus('Transcript cleared. Audio is still available.');
  }

  private async copyAll(): Promise<void> {
    const text = this.segments.map((s) => s.text).join(' ');
    await navigator.clipboard.writeText(text);
    this.setStatus('Copied to clipboard.');
  }

  private escape(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
    );
  }
}
