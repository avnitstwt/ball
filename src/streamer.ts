import { createWriteStream, existsSync, unlinkSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';

export interface StreamerConfig {
  readonly mode: 'test' | 'production';
  readonly fps: number;
  readonly videoBitrate: string;
  readonly audioBitrate: string;
  readonly audioSampleRate: number;
  readonly enableAudio: boolean;
  readonly backgroundMusicPath: string;
  readonly backgroundMusicVolume: number;
  readonly testOutputPath: string;
  readonly productionUrl: string;
  readonly logPath: string;
}

export interface FfmpegDiagnostics {
  readonly found: boolean;
  readonly version: string;
  readonly videoToolboxAvailable: boolean;
}

export interface StreamerStats {
  readonly status: 'IDLE' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'STOPPED' | 'FAILED';
  readonly framesAttempted: number;
  readonly framesWritten: number;
  readonly framesDropped: number;
  readonly restartCount: number;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class FrameStreamer {
  private readonly config: StreamerConfig;
  private readonly onUnexpectedExit: (error: Error) => void;
  private child: ChildProcess | null = null;
  private input: Writable | null = null;
  private logStream: WriteStream | null = null;
  private pendingFrame: Buffer | null = null;
  private waitingForDrain = false;
  private stopping = false;
  private status: StreamerStats['status'] = 'IDLE';
  private framesAttempted = 0;
  private framesWritten = 0;
  private framesDropped = 0;
  private restartCount = 0;
  private logBytes = 0;
  private logCapped = false;

  public constructor(config: StreamerConfig, onUnexpectedExit: (error: Error) => void) {
    this.config = config;
    this.onUnexpectedExit = onUnexpectedExit;
  }

  public static diagnose(): FfmpegDiagnostics {
    const versionResult = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true });
    if (versionResult.error || versionResult.status !== 0) {
      return { found: false, version: 'not found', videoToolboxAvailable: false };
    }
    const firstLine = (versionResult.stdout || versionResult.stderr).split(/\r?\n/u)[0] ?? 'unknown version';
    const encoderResult = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], {
      encoding: 'utf8',
      windowsHide: true
    });
    const encoderText = `${encoderResult.stdout ?? ''}\n${encoderResult.stderr ?? ''}`;
    return {
      found: true,
      version: firstLine.trim(),
      videoToolboxAvailable: encoderResult.status === 0 && encoderText.includes('h264_videotoolbox')
    };
  }

  public async start(): Promise<void> {
    if (this.child) throw new Error('FFmpeg is already running');
    this.status = 'STARTING';
    this.stopping = false;
    if (this.config.mode === 'test' && existsSync(this.config.testOutputPath)) unlinkSync(this.config.testOutputPath);

    const args = this.buildArguments();
    this.logStream = createWriteStream(this.config.logPath, { flags: 'w', mode: 0o600 });
    this.writeLog(`[${new Date().toISOString()}] FFmpeg starting in ${this.config.mode} mode\n`);
    const child = spawn('ffmpeg', args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
      env: { ...process.env, AV_LOG_FORCE_NOCOLOR: '1' }
    });
    this.child = child;
    this.input = child.stdin;

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: Buffer | string) => this.writeLog(this.redact(String(chunk))));
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (!this.stopping) this.handleFailure(new Error(`FFmpeg input failed: ${error.code ?? error.message}`));
    });
    child.on('error', (error) => {
      if (!this.stopping) this.handleFailure(new Error(`Unable to start FFmpeg: ${error.message}`));
    });
    child.on('exit', (code, signal) => {
      this.input = null;
      this.child = null;
      if (this.stopping) {
        this.status = 'STOPPED';
        return;
      }
      this.handleFailure(new Error(`FFmpeg exited unexpectedly (code ${String(code)}, signal ${String(signal)})`));
    });

    await this.verifyAlive(child);
    if (!this.child || this.child.exitCode !== null) throw new Error('FFmpeg did not remain alive after startup');
    this.status = 'RUNNING';
    this.writeLog(`[${new Date().toISOString()}] FFmpeg input is ready\n`);
  }

  private buildArguments(): string[] {
    const args = [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'warning',
      '-use_wallclock_as_timestamps',
      '1',
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      '-i',
      'pipe:0'
    ];

    const useMusic = this.config.enableAudio && existsSync(this.config.backgroundMusicPath);
    if (useMusic) {
      args.push('-stream_loop', '-1', '-i', this.config.backgroundMusicPath);
    } else {
      args.push(
        '-f',
        'lavfi',
        '-i',
        `anullsrc=channel_layout=stereo:sample_rate=${this.config.audioSampleRate}`
      );
    }

    args.push('-map', '0:v:0', '-map', '1:a:0');
    if (useMusic) args.push('-filter:a', `volume=${this.config.backgroundMusicVolume.toFixed(3)}`);

    if (this.config.mode === 'production') {
      args.push('-c:v', 'h264_videotoolbox', '-realtime', '1', '-profile:v', 'high');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency');
    }

    args.push(
      '-r',
      String(this.config.fps),
      '-pix_fmt',
      'yuv420p',
      '-b:v',
      this.config.videoBitrate,
      '-maxrate',
      this.config.videoBitrate,
      '-bufsize',
      this.doubleBitrate(this.config.videoBitrate),
      '-g',
      String(this.config.fps * 2),
      '-keyint_min',
      String(this.config.fps * 2),
      '-c:a',
      'aac',
      '-b:a',
      this.config.audioBitrate,
      '-ar',
      String(this.config.audioSampleRate),
      '-ac',
      '2',
      '-shortest'
    );

    if (this.config.mode === 'production') {
      args.push('-f', 'flv', '-flvflags', 'no_duration_filesize', this.config.productionUrl);
    } else {
      args.push('-movflags', '+faststart', '-f', 'mp4', this.config.testOutputPath);
    }
    return args;
  }

  private doubleBitrate(bitrate: string): string {
    const match = /^(\d+)([kKmM]?)$/u.exec(bitrate.trim());
    if (!match) return bitrate;
    const numeric = Number.parseInt(match[1] ?? '0', 10);
    const suffix = match[2] ?? '';
    return `${numeric * 2}${suffix}`;
  }

  private async verifyAlive(child: ChildProcess): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        child.off('exit', earlyExit);
        resolve();
      }, 1_500);
      const earlyExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`FFmpeg failed during startup (code ${String(code)}, signal ${String(signal)})`));
      };
      child.once('exit', earlyExit);
    });
  }

  public writeFrame(frame: Buffer): void {
    this.framesAttempted += 1;
    if (this.status !== 'RUNNING' || !this.input) {
      this.framesDropped += 1;
      return;
    }
    if (this.waitingForDrain) {
      if (this.pendingFrame) this.framesDropped += 1;
      this.pendingFrame = frame;
      return;
    }
    this.writeNow(frame);
  }

  private writeNow(frame: Buffer): void {
    const input = this.input;
    if (!input || this.status !== 'RUNNING') {
      this.framesDropped += 1;
      return;
    }
    const accepted = input.write(frame);
    this.framesWritten += 1;
    if (!accepted) {
      this.waitingForDrain = true;
      input.once('drain', () => {
        this.waitingForDrain = false;
        const newest = this.pendingFrame;
        this.pendingFrame = null;
        if (newest) this.writeNow(newest);
      });
    }
  }

  public noteDroppedFrames(count = 1): void {
    this.framesAttempted += count;
    this.framesDropped += count;
  }

  public getStats(): StreamerStats {
    return {
      status: this.status,
      framesAttempted: this.framesAttempted,
      framesWritten: this.framesWritten,
      framesDropped: this.framesDropped,
      restartCount: this.restartCount
    };
  }

  public async stop(): Promise<void> {
    if (this.stopping || this.status === 'STOPPED' || this.status === 'IDLE') return;
    this.stopping = true;
    this.status = 'STOPPING';
    this.pendingFrame = null;
    const child = this.child;
    const input = this.input;
    if (!child) {
      this.status = 'STOPPED';
      this.closeLog();
      return;
    }

    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    if (input && !input.destroyed) input.end();
    await Promise.race([exited, wait(8_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([exited, wait(3_000)]);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    this.status = 'STOPPED';
    this.child = null;
    this.input = null;
    this.closeLog();
  }

  private handleFailure(error: Error): void {
    if (this.status === 'FAILED') return;
    this.status = 'FAILED';
    this.writeLog(`[${new Date().toISOString()}] ${this.redact(error.message)}\n`);
    this.onUnexpectedExit(error);
  }

  private redact(text: string): string {
    let redacted = text;
    if (this.config.productionUrl) redacted = redacted.split(this.config.productionUrl).join('[REDACTED_RTMPS_URL]');
    redacted = redacted.replace(/rtmps?:\/\/[^\s]+/giu, '[REDACTED_RTMPS_URL]');
    redacted = redacted.replace(/([?&](?:key|token|sig|signature)=)[^&\s]+/giu, '$1[REDACTED]');
    return redacted;
  }

  private writeLog(text: string): void {
    if (!this.logStream || this.logCapped) return;
    const redacted = this.redact(text);
    const bytes = Buffer.byteLength(redacted, 'utf8');
    const maximumLogBytes = 5 * 1_048_576;
    if (this.logBytes + bytes > maximumLogBytes) {
      const notice = `[${new Date().toISOString()}] FFmpeg log reached the 5 MB local safety limit; additional lines are omitted.\n`;
      this.logStream.write(notice);
      this.logBytes += Buffer.byteLength(notice, 'utf8');
      this.logCapped = true;
      return;
    }
    this.logStream.write(redacted);
    this.logBytes += bytes;
  }

  private closeLog(): void {
    this.logStream?.end();
    this.logStream = null;
  }
}
