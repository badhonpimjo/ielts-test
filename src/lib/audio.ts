/**
 * Microphone capture + resampling to 16 kHz mono PCM.
 *
 * Strategy:
 *   - Open an AudioContext at the device's native rate.
 *   - Downmix to mono via ChannelMergerNode(1) if needed.
 *   - Resample to 16 kHz with an OfflineAudioContext built lazily.
 *   - Push rolling windows into a Float32Array buffer.
 *   - Report a normalized RMS level for the on-screen meter.
 */

const TARGET_SAMPLE_RATE = 16_000;

export type LevelListener = (level: number) => void;

let sharedAudioCtx: AudioContext | null = null;
function getSharedAudioContext(): AudioContext {
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
    sharedAudioCtx = new AudioContext();
  }
  return sharedAudioCtx;
}

/**
 * Decode an arbitrary audio file (mp3, wav, webm, m4a) into mono
 * 16 kHz Float32 PCM using OfflineAudioContext.
 */
export async function decodeFileToPcm(
  file: Blob,
  targetSampleRate = TARGET_SAMPLE_RATE,
): Promise<Float32Array> {
  const arrayBuffer = await file.arrayBuffer();
  const decodeCtx = getSharedAudioContext();
  const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);

  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const mono = new Float32Array(length);
  for (let c = 0; c < channels; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += data[i] / channels;
  }

  if (audioBuffer.sampleRate === targetSampleRate) {
    return mono;
  }

  // Resample via OfflineAudioContext for accuracy.
  const targetLength = Math.ceil((length * targetSampleRate) / audioBuffer.sampleRate);
  const offline = new OfflineAudioContext(1, targetLength, targetSampleRate);
  const src = offline.createBuffer(1, length, audioBuffer.sampleRate);
  src.copyToChannel(mono, 0);
  const bufSrc = offline.createBufferSource();
  bufSrc.buffer = src;
  bufSrc.connect(offline.destination);
  bufSrc.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

export interface RecordingResult {
  pcm: Float32Array;
  durationSeconds: number;
  wavBlob: Blob;
  audioUrl: string;
}

/**
 * Continuous Audio Recorder that captures pristine audio via native MediaRecorder
 * and decodes with high precision into 16 kHz Float32 PCM.
 */
export class AudioRecorder {
  private stream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private animFrameId: number | null = null;

  constructor(private readonly onLevel?: LevelListener) {}

  async start(): Promise<void> {
    if (this.stream) return;
    this.chunks = [];

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    let mimeType = 'audio/webm';
    if (!MediaRecorder.isTypeSupported('audio/webm')) {
      if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
      else if (MediaRecorder.isTypeSupported('audio/ogg')) mimeType = 'audio/ogg';
      else mimeType = '';
    }

    this.mediaRecorder = mimeType
      ? new MediaRecorder(this.stream, { mimeType })
      : new MediaRecorder(this.stream);

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this.chunks.push(e.data);
      }
    };

    this.mediaRecorder.start(100);

    // Real-time audio meter via AnalyserNode
    try {
      this.audioCtx = new AudioContext();
      const source = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);

      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      const checkLevel = () => {
        if (!this.analyser) return;
        this.analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        const normalized = Math.min(1, avg / 70);
        this.onLevel?.(normalized);
        this.animFrameId = requestAnimationFrame(checkLevel);
      };
      this.animFrameId = requestAnimationFrame(checkLevel);
    } catch {
      // Ignore meter errors
    }
  }

  async stop(): Promise<RecordingResult> {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    this.onLevel?.(0);
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.analyser = null;

    return new Promise((resolve) => {
      if (!this.mediaRecorder) {
        throw new Error('MediaRecorder was not started');
      }

      this.mediaRecorder.onstop = async () => {
        this.stream?.getTracks().forEach((t) => t.stop());
        this.stream = null;

        const blob = new Blob(this.chunks, {
          type: this.mediaRecorder?.mimeType || 'audio/webm',
        });
        this.chunks = [];

        // High-precision decode and resample to 16 kHz Float32 mono PCM
        const pcm = await decodeFileToPcm(blob, TARGET_SAMPLE_RATE);
        const durationSeconds = pcm.length / TARGET_SAMPLE_RATE;
        const audioUrl = URL.createObjectURL(blob);

        resolve({
          pcm,
          durationSeconds,
          wavBlob: blob,
          audioUrl,
        });
      };

      this.mediaRecorder.stop();
    });
  }
}