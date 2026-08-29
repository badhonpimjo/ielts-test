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
    options?: WhisperParams | { startedAt?: number; [key: string]: unknown },
  ): Promise<WhisperSegment[]>;
  dispose?(): void;
}

export class App {
  private recorder: AudioRecorder | null = null;
  // Lazily assigned by initServerEngine() -> switchEngine(). There is only
  // one engine now (server-side, routed via Groq), so no in-browser worker
  // is ever spawned.
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
            <p class="sub">High-performance speech-to-text transcription powered by OpenAI Whisper.</p>
          </div>
          <div id="device-badge" class="device-badge">Detecting hardware…</div>
        </div>
      </header>

      <section class="card engine-card">
        <div class="engine-selector-group">
          <label for="engine-select" class="engine-label">🧠 AI Engine & Model:</label>
          <select id="engine-select" class="engine-select">
            <option value="server-base" selected>⚡ Server (Groq Whisper Turbo) — Fast Real-Time & High Accuracy</option>
          </select>
        </div>
        <div id="engine-info" class="engine-info">🚀 Server Backend via Groq Whisper Turbo (0 MB client download, ultra-fast real-time transcription).</div>
        
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

      <footer class="ftr">
        <span id="footer-text">Speech is processed 100% locally and privately in your browser.</span>
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
    // Use a relative /api base — same-origin in dev, proxied by your hosting
    // provider in prod. ServerTranscriber will surface a clear error if the
    // backend is unreachable.
    const apiBase = '/api';

    // Server is the only engine — always point at it. If the backend is
    // down, the ServerTranscriber.load() call will surface a clear error.
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

    // Same `/api` base as in initServerEngine() — relative in dev, proxied
    // by the hosting provider in prod.
    const apiBase = '/api';

    switch (engineKey) {
      case 'server-base':
        this.transcriber = new ServerTranscriber(apiBase, 'base');
        if (infoEl) infoEl.textContent = '🚀 Server Backend via Groq Whisper Turbo (0 MB client download, ultra-fast real-time transcription).';
        break;

      default:
        this.transcriber = new ServerTranscriber(apiBase, 'base');
        if (infoEl) infoEl.textContent = '🚀 Server Backend via Groq Whisper Turbo (0 MB client download, ultra-fast real-time transcription).';
        break;
    }

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

    // Background pre-warm the active model pipeline while user is speaking (0ms cold start)
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

    // Show audio player preview
    const container = this.root.querySelector<HTMLElement>('#audio-preview-container')!;
    const audioEl = this.root.querySelector<HTMLAudioElement>('#audio-preview')!;
    audioEl.src = result.audioUrl;
    container.style.display = 'block';

    if (result.durationSeconds < 0.3) {
      this.setStatus('Recording was too short. Speak longer.');
      return;
    }

    // Save PCM for manual / repeat transcription with any model
    this.lastPcm = result.pcm;
    this.lastAudioDuration = result.durationSeconds;

    const labelEl = this.root.querySelector<HTMLElement>('#audio-preview-label');
    if (labelEl) labelEl.textContent = `🎧 Recorded Audio (${result.durationSeconds.toFixed(1)}s):`;

    this.setStatus(`Audio recorded (${result.durationSeconds.toFixed(1)}s). Select your model and click "Transcribe Audio".`);
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

    try {
      if (!this.transcriber) {
        this.setStatus('No engine selected yet.');
        return;
      }
      await this.transcriber.load((m) => this.setStatus(m));
      const t0 = performance.now();
      const segs = await this.transcriber.transcribe(this.lastPcm);
      const latencyMs = Math.round(performance.now() - t0);
      const speedFactor = this.lastAudioDuration / Math.max(0.01, latencyMs / 1000);
      this.appendSegments(segs);
      // Surface the engine + latency the server reported.
      let engineLabel = '';
      if (this.transcriber instanceof ServerTranscriber) {
        const st = this.transcriber as ServerTranscriber;
        if (st.lastEngineUsed) engineLabel = ` via ${st.lastEngineUsed}`;
        if (st.lastLatencyMs !== null) engineLabel += ` (server ${st.lastLatencyMs}ms)`;
      }
      this.setStatus(`Done: ${segs.length} segments in ${(latencyMs / 1000).toFixed(2)}s (${speedFactor.toFixed(1)}x Real-Time Speed)${engineLabel}.`);
    } catch (err) {
      this.setStatus(`Transcription failed: ${(err as Error).message}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /**
   * Delete the current audio from memory and hide player
   */
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

  /**
   * Mode 2: File Upload
   */
  private async handleFile(file: File | undefined): Promise<void> {
    if (!file) return;
    this.setStatus(`Decoding ${file.name}…`);

    // Show preview player for uploaded file
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
