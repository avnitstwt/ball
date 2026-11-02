import 'dotenv/config';
import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, accessSync, constants, createReadStream, statSync } from 'node:fs';
import { resolve, dirname, extname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import type { Browser, Page, CDPSession } from 'playwright';
import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';
import { z } from 'zod';
import { EndlessGame } from './game.js';
import type { GameConfig, GameState, SessionSummary } from './game.js';
import { GameDatabase } from './database.js';
import { FrameStreamer } from './streamer.js';
import type { StreamerStats } from './streamer.js';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(sourceDirectory, '..');
const publicDirectory = resolve(projectDirectory, 'public');
const runtimeDirectory = resolve(projectDirectory, 'runtime');

function numeric(defaultValue: number, minimum: number, maximum: number, integer = false) {
  return z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === '') return defaultValue;
      const parsed = typeof value === 'number' ? value : Number(value);
      return parsed;
    },
    z.number().finite().transform((value) => {
      const clamped = Math.min(maximum, Math.max(minimum, value));
      return integer ? Math.round(clamped) : clamped;
    })
  );
}

function booleanValue(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    return value;
  }, z.boolean());
}

function volumePercent(defaultValue = 0.08) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return defaultValue;
      const normalized = value > 1 ? value / 100 : value;
      return Math.min(1, Math.max(0, normalized));
    }
    const str = String(value).trim();
    if (str.endsWith('%')) {
      const num = parseFloat(str.slice(0, -1));
      return Number.isFinite(num) ? Math.min(1, Math.max(0, num / 100)) : defaultValue;
    }
    const parsed = parseFloat(str);
    if (!Number.isFinite(parsed)) return defaultValue;
    const normalized = parsed > 1 ? parsed / 100 : parsed;
    return Math.min(1, Math.max(0, normalized));
  }, z.number().min(0).max(1));
}

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().trim().default('127.0.0.1').refine((value) => value === '127.0.0.1' || value === '0.0.0.0', 'HOST must be 127.0.0.1 or 0.0.0.0'),
  PORT: numeric(3000, 1024, 65_535, true),
  WIDTH: numeric(1080, 540, 2160, true),
  HEIGHT: numeric(1920, 960, 3840, true),
  FPS: numeric(30, 15, 60, true),
  TEST_MODE: booleanValue(true),
  TEST_DURATION_SECONDS: numeric(120, 5, 3_600, true),
  STREAM_DURATION_SECONDS: numeric(0, 0, 604_800, true),
  YOUTUBE_RTMPS_URL: z.string().trim().default(''),
  VIDEO_BITRATE: z.string().trim().regex(/^\d+[kKmM]$/u, 'VIDEO_BITRATE must look like 4500k').default('4500k'),
  AUDIO_BITRATE: z.string().trim().regex(/^\d+[kKmM]$/u, 'AUDIO_BITRATE must look like 128k').default('128k'),
  AUDIO_SAMPLE_RATE: numeric(44_100, 8_000, 96_000, true),
  ENABLE_AUDIO: booleanValue(false),
  BACKGROUND_MUSIC_PATH: z.string().trim().default('assets/background-music.mp3'),
  BACKGROUND_MUSIC_VOLUME: volumePercent(0.08),
  PERSON_PHOTO_PATH: z.string().trim().default('assets/person-photo.jpg'),
  PERSON_PHOTO_FIT: z.enum(['cover', 'contain']).default('cover'),
  PAYMENT_QR_PATH: z.string().trim().default('assets/payment-qr.jpg'),
  QR_LABEL: z.string().trim().min(1).max(60).default('Scan to Support'),
  QR_X: numeric(735, 0, 2_000, true),
  QR_Y: numeric(960, 0, 3_800, true),
  QR_WIDTH: numeric(305, 180, 700, true),
  QR_PADDING: numeric(18, 8, 64, true),
  GAME_AREA_HEIGHT: numeric(1_120, 600, 2_400, true),
  PHOTO_AREA_Y: numeric(1_120, 500, 3_200, true),
  PHYSICS_HZ: numeric(60, 30, 120, true),
  GRAVITY_Y: numeric(1, 0.1, 2.5),
  AUTO_DROP_MIN_MS: numeric(1_200, 400, 10_000, true),
  AUTO_DROP_MAX_MS: numeric(3_500, 600, 15_000, true),
  AUTO_HESITATION_CHANCE: numeric(0.1, 0, 0.8),
  AUTO_RISK_CHANCE: numeric(0.18, 0, 0.7),
  MIN_GAME_DURATION_SECONDS: numeric(7_200, 60, 86_400, true),
  MAX_GAME_DURATION_SECONDS: numeric(10_800, 60, 172_800, true),
  GAME_RESTART_MIN_SECONDS: numeric(8, 3, 120, true),
  GAME_RESTART_MAX_SECONDS: numeric(15, 3, 180, true),
  MAX_ACTIVE_BALLS: numeric(120, 30, 250, true),
  MAX_PARTICLES: numeric(300, 50, 1_000, true),
  MERGE_CONTACT_MS: numeric(120, 40, 500, true),
  RECOVERY_ENABLED: booleanValue(true),
  GAME_SEED: z.string().trim().max(128).default(''),
  STREAM_TITLE: z.string().trim().min(1).max(80).default('Endless Ball Drop'),
  SHOW_DEVELOPMENT_GUIDES: booleanValue(false)
}).superRefine((value, context) => {
  if (value.AUTO_DROP_MAX_MS < value.AUTO_DROP_MIN_MS) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['AUTO_DROP_MAX_MS'], message: 'must be >= AUTO_DROP_MIN_MS' });
  }
  if (value.MAX_GAME_DURATION_SECONDS < value.MIN_GAME_DURATION_SECONDS) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['MAX_GAME_DURATION_SECONDS'], message: 'must be >= MIN_GAME_DURATION_SECONDS' });
  }
  if (value.GAME_RESTART_MAX_SECONDS < value.GAME_RESTART_MIN_SECONDS) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['GAME_RESTART_MAX_SECONDS'], message: 'must be >= GAME_RESTART_MIN_SECONDS' });
  }
  if (value.GAME_AREA_HEIGHT > value.HEIGHT || value.PHOTO_AREA_Y > value.HEIGHT) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['HEIGHT'], message: 'layout boundaries must fit inside HEIGHT' });
  }
  if (value.QR_X + value.QR_WIDTH > value.WIDTH) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['QR_X'], message: 'QR panel must fit inside WIDTH' });
  }
});

type AppConfig = z.infer<typeof configSchema>;

type RunMode = 'diagnostics' | 'preview' | 'preview-layout' | 'test' | 'production';

interface ImageInfo {
  readonly found: boolean;
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly path: string;
}

interface RuntimeExport extends SessionSummary {
  readonly streamMode: 'test' | 'production' | 'preview';
  readonly totalFramesAttempted: number;
  readonly totalFramesDropped: number;
  readonly FFmpegRestartCount: number;
}

function parseConfiguration(): AppConfig {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}

function determineMode(config: AppConfig): RunMode {
  const args = new Set(process.argv.slice(2));
  if (args.has('--diagnostics')) return 'diagnostics';
  if (args.has('--preview-layout')) return 'preview-layout';
  if (args.has('--preview')) return 'preview';
  if (args.has('--test')) return 'test';
  return config.TEST_MODE ? 'test' : 'production';
}

function resolveInsideProject(configuredPath: string): string {
  const absolute = resolve(projectDirectory, configuredPath);
  const pathRelative = relative(projectDirectory, absolute);
  if (pathRelative.startsWith(`..${sep}`) || pathRelative === '..' || pathRelative === '' && absolute !== projectDirectory) {
    throw new Error(`Configured path escapes project directory: ${configuredPath}`);
  }
  return absolute;
}

function readImageInfo(path: string): ImageInfo {
  if (!existsSync(path)) return { found: false, width: 0, height: 0, format: 'missing', path };
  const buffer = readFileSync(path);
  if (buffer.length >= 24 && buffer.subarray(1, 4).toString('ascii') === 'PNG') {
    return { found: true, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: 'PNG', path };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1] ?? 0;
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2 || offset + length + 2 > buffer.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return {
          found: true,
          width: buffer.readUInt16BE(offset + 7),
          height: buffer.readUInt16BE(offset + 5),
          format: 'JPEG',
          path
        };
      }
      offset += length + 2;
    }
  }
  throw new Error(`Unsupported or invalid image file: ${path}`);
}

function resolveAssetPath(configuredPath: string): string {
  const resolved = resolveInsideProject(configuredPath);
  if (existsSync(resolved)) return resolved;
  const ext = extname(resolved).toLowerCase();
  const withoutExt = resolved.slice(0, -ext.length || undefined);
  const alternatives = ext === '.jpg' || ext === '.jpeg' || ext === '.png'
    ? ['.jpg', '.jpeg', '.png']
    : ext === '.mp3' || ext === '.m4a' || ext === '.wav' || ext === '.webm' || ext === '.aac'
      ? ['.mp3', '.m4a', '.wav', '.webm', '.aac']
      : ['.jpg', '.jpeg', '.png', '.mp3', '.m4a', '.wav'];
  for (const alt of alternatives) {
    if (existsSync(withoutExt + alt)) return withoutExt + alt;
  }
  return resolved;
}

function validateAssets(config: AppConfig, production: boolean): { photo: ImageInfo; qr: ImageInfo; photoPath: string; qrPath: string; musicPath: string } {
  const photoPath = resolveAssetPath(config.PERSON_PHOTO_PATH);
  const qrPath = resolveAssetPath(config.PAYMENT_QR_PATH);
  const musicPath = resolveAssetPath(config.BACKGROUND_MUSIC_PATH);
  const photo = readImageInfo(photoPath);
  const qr = readImageInfo(qrPath);
  if (production && (!photo.found || !qr.found)) {
    throw new Error('Production requires valid local assets/person-photo.jpg and assets/payment-qr.jpg (or .jpeg)');
  }
  return { photo, qr, photoPath, qrPath, musicPath };
}

function ensureRuntimeDirectory(): void {
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
  accessSync(runtimeDirectory, constants.R_OK | constants.W_OK);
}

function placeholderSvg(label: string, width: number, height: number): Buffer {
  const escaped = label.replace(/[<>&'"]/gu, '');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#171d3d"/><text x="50%" y="50%" fill="#eef1ff" font-family="system-ui" font-size="36" text-anchor="middle">${escaped}</text></svg>`);
}

function contentType(path: string): string {
  const extension = extname(path).toLowerCase();
  const types: Readonly<Record<string, string>> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.mp3': 'audio/mpeg'
  };
  return types[extension] ?? 'application/octet-stream';
}

function sendBuffer(response: ServerResponse, status: number, type: string, body: Buffer): void {
  response.writeHead(status, {
    'Content-Type': type,
    'Content-Length': String(body.length),
    'Cache-Control': type.startsWith('image/') ? 'private, max-age=60' : 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; media-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  });
  response.end(body);
}

function streamMediaFile(request: IncomingMessage, response: ServerResponse, filePath: string, mimeType: string): void {
  const stat = statSync(filePath);
  const fileSize = stat.size;
  const range = request.headers.range;

  const baseHeaders: Record<string, string> = {
    'Content-Type': mimeType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; media-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  };

  if (request.method === 'HEAD') {
    response.writeHead(200, {
      ...baseHeaders,
      'Content-Length': String(fileSize)
    });
    response.end();
    return;
  }

  if (range) {
    const parts = range.replace(/bytes=/u, '').split('-');
    const start = parseInt(parts[0] ?? '0', 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize || start > end) {
      response.writeHead(416, {
        'Content-Range': `bytes */${fileSize}`,
        'Content-Type': 'text/plain'
      });
      response.end('Requested range not satisfiable');
      return;
    }

    const chunkLength = end - start + 1;
    response.writeHead(206, {
      ...baseHeaders,
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': String(chunkLength)
    });

    const stream = createReadStream(filePath, { start, end });
    stream.pipe(response);
  } else {
    response.writeHead(200, {
      ...baseHeaders,
      'Content-Length': String(fileSize)
    });

    const stream = createReadStream(filePath);
    stream.pipe(response);
  }
}

function createStaticServer(
  config: AppConfig,
  assets: ReturnType<typeof validateAssets>
): { server: HttpServer; websocketServer: WebSocketServer; sockets: Set<WebSocket> } {
  const staticFiles = new Map<string, string>([
    ['/', resolve(publicDirectory, 'index.html')],
    ['/index.html', resolve(publicDirectory, 'index.html')],
    ['/styles.css', resolve(publicDirectory, 'styles.css')],
    ['/client.js', resolve(publicDirectory, 'client.js')]
  ]);
  const sockets = new Set<WebSocket>();
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendBuffer(response, 405, 'text/plain; charset=utf-8', Buffer.from('Method not allowed'));
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      pathname = decodeURIComponent(pathname);
    } catch {
      sendBuffer(response, 400, 'text/plain; charset=utf-8', Buffer.from('Bad request'));
      return;
    }
    if (pathname.includes('..') || pathname.includes('\\') || pathname.includes('\0')) {
      sendBuffer(response, 403, 'text/plain; charset=utf-8', Buffer.from('Forbidden'));
      return;
    }

    let filePath = staticFiles.get(pathname);
    if (pathname === '/assets/person-photo.jpg' || pathname === '/assets/person-photo.jpeg') filePath = assets.photoPath;
    if (pathname === '/assets/payment-qr.jpg' || pathname === '/assets/payment-qr.jpeg') filePath = assets.qrPath;
    if (pathname === '/assets/background-music.mp3' || pathname === '/assets/background-music') filePath = assets.musicPath;
    if (!filePath) {
      sendBuffer(response, 404, 'text/plain; charset=utf-8', Buffer.from('Not found'));
      return;
    }
    if (!existsSync(filePath)) {
      if (config.TEST_MODE && (pathname === '/assets/person-photo.jpg' || pathname === '/assets/person-photo.jpeg')) {
        sendBuffer(response, 200, 'image/svg+xml', placeholderSvg('Local photo placeholder', 1080, 800));
        return;
      }
      if (config.TEST_MODE && (pathname === '/assets/payment-qr.jpg' || pathname === '/assets/payment-qr.jpeg')) {
        sendBuffer(response, 200, 'image/svg+xml', placeholderSvg('Local QR placeholder', 500, 500));
        return;
      }
      sendBuffer(response, 404, 'text/plain; charset=utf-8', Buffer.from('Local asset not found'));
      return;
    }

    const type = contentType(filePath);
    if (pathname === '/assets/background-music.mp3' || type.startsWith('audio/')) {
      streamMediaFile(request, response, filePath, type);
      return;
    }

    const body = request.method === 'HEAD' ? Buffer.alloc(0) : readFileSync(filePath);
    sendBuffer(response, 200, type, body);
  });

  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 4_096, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    let pathname = '';
    try { pathname = new URL(request.url ?? '/', 'http://localhost').pathname; } catch { socket.destroy(); return; }
    if (pathname !== '/ws') { socket.destroy(); return; }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => websocketServer.emit('connection', websocket, request));
  });
  websocketServer.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return { server, websocketServer, sockets };
}

const inboundMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), client: z.enum(['capture', 'preview']) }).strict(),
  z.object({
    type: z.literal('control'),
    action: z.enum(['pause', 'resume', 'spawn', 'merge', 'recovery', 'gameover', 'reset', 'guides'])
  }).strict()
]);

function rawDataToString(data: RawData): string | null {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return null;
}

function broadcast(sockets: Set<WebSocket>, value: object): void {
  const payload = JSON.stringify(value);
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}

async function listen(server: HttpServer, host: string, port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error): void => { server.off('listening', onListening); reject(error); };
    const onListening = (): void => { server.off('error', onError); resolvePromise(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function closeServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

async function checkPort(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const probe = createNetServer();
    probe.once('error', () => resolvePromise(false));
    probe.once('listening', () => probe.close(() => resolvePromise(true)));
    probe.listen(port, host);
  });
}

function createGameConfig(config: AppConfig, mode: RunMode): GameConfig {
  return {
    width: config.WIDTH,
    height: config.HEIGHT,
    gameAreaHeight: config.GAME_AREA_HEIGHT,
    photoAreaY: config.PHOTO_AREA_Y,
    physicsHz: config.PHYSICS_HZ,
    gravityY: config.GRAVITY_Y,
    autoDropMinMs: config.AUTO_DROP_MIN_MS,
    autoDropMaxMs: config.AUTO_DROP_MAX_MS,
    autoHesitationChance: config.AUTO_HESITATION_CHANCE,
    autoRiskChance: config.AUTO_RISK_CHANCE,
    minGameDurationSeconds: config.MIN_GAME_DURATION_SECONDS,
    maxGameDurationSeconds: config.MAX_GAME_DURATION_SECONDS,
    gameRestartMinSeconds: config.GAME_RESTART_MIN_SECONDS,
    gameRestartMaxSeconds: config.GAME_RESTART_MAX_SECONDS,
    maxActiveBalls: config.MAX_ACTIVE_BALLS,
    maxParticles: config.MAX_PARTICLES,
    mergeContactMs: config.MERGE_CONTACT_MS,
    recoveryEnabled: config.RECOVERY_ENABLED,
    initialSeed: config.GAME_SEED,
    testMode: mode === 'test' || mode === 'preview-layout',
    testDurationSeconds: config.TEST_DURATION_SECONDS,
    streamTitle: config.STREAM_TITLE,
    qrX: config.QR_X,
    qrY: config.QR_Y,
    qrWidth: config.QR_WIDTH,
    qrPadding: config.QR_PADDING,
    qrLabel: config.QR_LABEL,
    personPhotoFit: config.PERSON_PHOTO_FIT,
    development: mode === 'preview' || config.NODE_ENV !== 'production',
    showDevelopmentGuides: config.SHOW_DEVELOPMENT_GUIDES,
    musicVolume: config.BACKGROUND_MUSIC_VOLUME
  };
}

async function launchRenderer(config: AppConfig): Promise<{ browser: Browser; page: Page; firstFrame: Buffer }> {
  const browser = await chromium.launch({ headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  const page = await browser.newPage({
    viewport: { width: config.WIDTH, height: config.HEIGHT },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce'
  });
  await page.goto(`http://127.0.0.1:${config.PORT}/?capture=1`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => (window as typeof window & { ballDropReady?: boolean }).ballDropReady === true, undefined, { timeout: 30_000 });
  const firstFrame = await page.screenshot({ type: 'jpeg', quality: 85 });
  if (firstFrame.length < 24) {
    await browser.close();
    throw new Error('Headless renderer produced an unexpected frame size');
  }
  return { browser, page, firstFrame };
}

function safeWriteJson(path: string, value: object): void {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function writeSessionExport(summary: SessionSummary, mode: RunMode, stats: StreamerStats): void {
  const streamMode: RuntimeExport['streamMode'] = mode === 'production' ? 'production' : mode === 'test' ? 'test' : 'preview';
  const exported: RuntimeExport = {
    ...summary,
    streamMode,
    totalFramesAttempted: stats.framesAttempted,
    totalFramesDropped: stats.framesDropped,
    FFmpegRestartCount: stats.restartCount
  };
  safeWriteJson(resolve(runtimeDirectory, 'session-summary.json'), exported);
  appendFileSync(resolve(runtimeDirectory, 'session-history.jsonl'), `${JSON.stringify(exported)}\n`, { mode: 0o600 });
}

function printDiagnostics(config: AppConfig, assets: ReturnType<typeof validateAssets>, ffmpeg: ReturnType<typeof FrameStreamer.diagnose>, portAvailable: boolean): void {
  let chromiumAvailable = false;
  try { chromiumAvailable = existsSync(chromium.executablePath()); } catch { chromiumAvailable = false; }
  const dimensionText = (info: ImageInfo): string => info.found ? `YES (${info.width}x${info.height}, ${info.format})` : 'NO';
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['Node version', process.version],
    ['Platform', process.platform],
    ['Architecture', process.arch],
    ['FFmpeg version', ffmpeg.version],
    ['h264_videotoolbox', ffmpeg.videoToolboxAvailable ? 'AVAILABLE' : 'NOT AVAILABLE'],
    ['Project directory', projectDirectory],
    ['Runtime write access', 'YES'],
    ['SQLite access', 'YES'],
    ['Person photo found', dimensionText(assets.photo)],
    ['Payment QR found', dimensionText(assets.qr)],
    ['Port available', portAvailable ? `YES (${config.HOST}:${config.PORT})` : `NO (${config.HOST}:${config.PORT})`],
    ['Playwright Chromium', chromiumAvailable ? 'AVAILABLE' : 'NOT INSTALLED'],
    ['TEST_MODE', String(config.TEST_MODE)],
    ['Width', String(config.WIDTH)],
    ['Height', String(config.HEIGHT)],
    ['FPS', String(config.FPS)],
    ['Raw frame byte size', String(config.WIDTH * config.HEIGHT * 4)],
    ['Audio enabled', config.ENABLE_AUDIO ? 'YES' : 'NO'],
    ['Audio volume', `${Math.round(config.BACKGROUND_MUSIC_VOLUME * 100)}% (${config.BACKGROUND_MUSIC_VOLUME.toFixed(2)})`],
    ['Background music file', existsSync(assets.musicPath) ? `FOUND (${config.BACKGROUND_MUSIC_PATH})` : `NOT FOUND (${config.BACKGROUND_MUSIC_PATH})`],
    ['YOUTUBE_RTMPS_URL configured', config.YOUTUBE_RTMPS_URL ? 'YES' : 'NO']
  ];
  for (const [label, value] of rows) console.log(`${label}: ${value}`);
}

function redactedError(error: unknown, secret: string): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  let message = original.message;
  if (secret) message = message.split(secret).join('[REDACTED_RTMPS_URL]');
  message = message.replace(/rtmps?:\/\/[^\s]+/giu, '[REDACTED_RTMPS_URL]');
  return new Error(message);
}

async function productionCountdown(): Promise<void> {
  console.log('Production stream begins in:');
  for (let count = 5; count >= 1; count -= 1) {
    console.log(String(count));
    await sleep(1_000);
  }
}

async function run(): Promise<void> {
  const config = parseConfiguration();
  const mode = determineMode(config);
  ensureRuntimeDirectory();
  const assets = validateAssets(config, mode === 'production');
  const ffmpegDiagnostics = FrameStreamer.diagnose();

  if (mode === 'diagnostics') {
    const database = new GameDatabase(resolve(runtimeDirectory, 'game.db'));
    database.verifyAccess();
    database.close();
    const portAvailable = await checkPort(config.HOST, config.PORT);
    printDiagnostics(config, assets, ffmpegDiagnostics, portAvailable);
    return;
  }

  if (mode === 'production') {
    if (!config.YOUTUBE_RTMPS_URL.startsWith('rtmps://')) throw new Error('Production requires a valid YOUTUBE_RTMPS_URL beginning with rtmps://');
    if (!ffmpegDiagnostics.found) throw new Error('FFmpeg was not found');
    if (!ffmpegDiagnostics.videoToolboxAvailable) throw new Error('h264_videotoolbox is unavailable; production will not start');
  }
  if ((mode === 'test' || mode === 'production') && !ffmpegDiagnostics.found) throw new Error('FFmpeg was not found');
  if (config.ENABLE_AUDIO && !existsSync(assets.musicPath)) {
    throw new Error('ENABLE_AUDIO=true but the configured local background music file does not exist');
  }
  if (config.HOST === '0.0.0.0') console.warn('LAN WARNING: preview is visible on the local network. Do not configure port forwarding.');

  const database = new GameDatabase(resolve(runtimeDirectory, 'game.db'));
  let streamer: FrameStreamer | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;
  let cdpSession: CDPSession | null = null;
  let game: EndlessGame | null = null;
  let shutdownStarted = false;
  let shutdownReason = 'normal stop';
  let shutdownStatus: SessionSummary['status'] = 'INTERRUPTED';
  let processExitCode = 0;
  let activeSessionSaved = false;
  let gameStarted = false;
  let captureRunning = false;
  let capturePromise: Promise<void> | null = null;
  const savedSessions = new Set<string>();
  const intervals: NodeJS.Timeout[] = [];
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();
  const { server, websocketServer, sockets } = createStaticServer(config, assets);

  const emptyStats = (): StreamerStats => ({ status: 'IDLE', framesAttempted: 0, framesWritten: 0, framesDropped: 0, restartCount: 0 });
  const currentStats = (): StreamerStats => streamer?.getStats() ?? emptyStats();
  const persistSession = (summary: SessionSummary, state: GameState): void => {
    if (savedSessions.has(summary.sessionId)) return;
    database.completeSession(summary, state);
    savedSessions.add(summary.sessionId);
    activeSessionSaved = true;
    writeSessionExport(summary, mode, currentStats());
    game?.setBestScore(database.getBestScore());
  };

  const callbacks = {
    onSessionStart: (state: GameState): void => {
      database.beginSession(state);
      activeSessionSaved = false;
      gameStarted = true;
    },
    onCheckpoint: (state: GameState): void => database.checkpoint(state),
    onSessionEnd: (summary: SessionSummary, state: GameState): void => persistSession(summary, state)
  };
  game = new EndlessGame(createGameConfig(config, mode), database.getBestScore(), callbacks);

  const fail = (error: unknown): void => {
    if (shutdownStarted) return;
    const safe = redactedError(error, config.YOUTUBE_RTMPS_URL);
    console.error(`Fatal: ${safe.message}`);
    processExitCode = 1;
    shutdownStatus = 'FAILED';
    shutdownReason = safe.message;
    game?.pauseSpawning('Stream stopped safely');
    void shutdown();
  };

  const shutdown = async (): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    captureRunning = false;
    for (const interval of intervals) clearInterval(interval);
    try {
      if (game && gameStarted && !activeSessionSaved) {
        const state = game.getState();
        const summary = game.buildSummary(shutdownStatus, shutdownReason);
        try { persistSession(summary, state); } catch (error) { console.error(`Session save failed: ${redactedError(error, config.YOUTUBE_RTMPS_URL).message}`); processExitCode = 1; }
      }
      if (capturePromise) await Promise.race([capturePromise, sleep(3_000)]);
      if (cdpSession) {
        await cdpSession.send('Page.stopScreencast').catch(() => undefined);
        await cdpSession.detach().catch(() => undefined);
      }
      if (streamer) await streamer.stop();
      if (page) await page.close().catch(() => undefined);
      if (browser) await browser.close().catch(() => undefined);
      for (const socket of sockets) socket.close(1001, 'Server stopping');
      websocketServer.close();
      await closeServer(server);
      game?.destroy();
      database.close();
      eventLoopDelay.disable();
    } finally {
      process.exitCode = processExitCode;
    }
  };

  process.once('SIGINT', () => { shutdownReason = 'SIGINT'; void shutdown(); });
  process.once('SIGTERM', () => { shutdownReason = 'SIGTERM'; void shutdown(); });
  process.once('uncaughtException', (error) => fail(error));
  process.once('unhandledRejection', (reason) => fail(reason));

  websocketServer.on('connection', (socket) => {
    socket.on('message', (rawData) => {
      const text = rawDataToString(rawData);
      if (!text || Buffer.byteLength(text, 'utf8') > 4_096) { socket.close(1009, 'Message too large'); return; }
      let parsedJson: unknown;
      try { parsedJson = JSON.parse(text); } catch { socket.close(1007, 'Invalid JSON'); return; }
      const parsed = inboundMessageSchema.safeParse(parsedJson);
      if (!parsed.success) { socket.send(JSON.stringify({ type: 'error', message: 'Invalid local message' })); return; }
      if (parsed.data.type === 'hello') {
        socket.send(JSON.stringify({ ...game!.getState(), development: config.NODE_ENV !== 'production' }));
        return;
      }
      if (config.NODE_ENV === 'production') { socket.send(JSON.stringify({ type: 'error', message: 'Controls disabled in production' })); return; }
      const action = parsed.data.action;
      if (action === 'pause') game!.pause();
      else if (action === 'resume') game!.resume();
      else if (action === 'spawn') game!.spawnNextBall();
      else if (action === 'merge') game!.forceSafeMerge();
      else if (action === 'recovery') game!.triggerRecovery();
      else if (action === 'gameover') game!.testGameOver();
      else if (action === 'reset') game!.resetSession();
      else if (action === 'guides') game!.toggleGuides();
    });
  });

  try {
    await listen(server, config.HOST, config.PORT);
    console.log(`Local preview: http://${config.HOST === '0.0.0.0' ? '127.0.0.1' : config.HOST}:${config.PORT}`);

    const physicsInterval = setInterval(() => {
      try { game!.advance(); } catch (error) { fail(new Error(`Physics update failed: ${redactedError(error, config.YOUTUBE_RTMPS_URL).message}`)); }
    }, 4);
    intervals.push(physicsInterval);

    let diagnosticWindowStarted = performance.now();
    let diagnosticFrames = 0;
    let averageFps = 0;
    let previousPhysicsUpdateCount = game.getPhysicsUpdateCount();
    const stateInterval = setInterval(() => {
      const state = game!.getState();
      broadcast(sockets, { ...state, development: config.NODE_ENV !== 'production' });
      diagnosticFrames += 1;
    }, Math.round(1_000 / config.FPS));
    intervals.push(stateInterval);

    const diagnosticsInterval = setInterval(() => {
    const now = performance.now();
    const elapsed = Math.max(1, now - diagnosticWindowStarted);
    averageFps = diagnosticFrames * 1_000 / elapsed;
    const currentPhysicsUpdateCount = game!.getPhysicsUpdateCount();
    const physicsUpdatesPerSecond = (currentPhysicsUpdateCount - previousPhysicsUpdateCount) * 1_000 / elapsed;
    previousPhysicsUpdateCount = currentPhysicsUpdateCount;
    diagnosticFrames = 0;
    diagnosticWindowStarted = now;
    const stats = currentStats();
    broadcast(sockets, {
      type: 'diagnostics',
      averageFps,
      physicsUpdatesPerSecond,
      frameWrites: stats.framesWritten,
      droppedFrames: stats.framesDropped,
      ffmpegStatus: stats.status,
      wsConnections: sockets.size,
      memoryMb: process.memoryUsage().rss / 1_048_576,
      eventLoopDelayMs: eventLoopDelay.mean / 1_000_000
    });
    eventLoopDelay.reset();
    }, 1_000);
    intervals.push(diagnosticsInterval);

    if (mode === 'preview') {
      game.start();
      return;
    }

    if (mode === 'preview-layout') game.start();
    const renderer = await launchRenderer(config);
    browser = renderer.browser;
    page = renderer.page;
    page.on('crash', () => fail(new Error('Headless renderer page crashed')));
    browser.on('disconnected', () => { if (!shutdownStarted) fail(new Error('Headless renderer disconnected')); });

    if (mode === 'preview-layout') {
      const pngFrame = await page.screenshot({ type: 'png', animations: 'disabled' });
      writeFileSync(resolve(runtimeDirectory, 'layout-preview.png'), pngFrame, { mode: 0o600 });
      shutdownReason = 'layout preview complete';
      await shutdown();
      return;
    }

    const streamerConfig = {
      mode: mode === 'production' ? 'production' as const : 'test' as const,
      fps: config.FPS,
      videoBitrate: config.VIDEO_BITRATE,
      audioBitrate: config.AUDIO_BITRATE,
      audioSampleRate: config.AUDIO_SAMPLE_RATE,
      enableAudio: config.ENABLE_AUDIO,
      backgroundMusicPath: assets.musicPath,
      backgroundMusicVolume: config.BACKGROUND_MUSIC_VOLUME,
      testOutputPath: resolve(runtimeDirectory, 'test-output.mp4'),
      productionUrl: config.YOUTUBE_RTMPS_URL,
      logPath: resolve(runtimeDirectory, 'ffmpeg.log')
    };
    streamer = new FrameStreamer(streamerConfig, (error) => fail(error));
    if (mode === 'production') await productionCountdown();
    await streamer.start();
    streamer.writeFrame(renderer.firstFrame);
    game.start();

    captureRunning = true;
    capturePromise = (async () => {
      if (!page || page.isClosed()) throw new Error('Headless renderer page closed');
      cdpSession = await page.context().newCDPSession(page);
      cdpSession.on('Page.screencastFrame', async ({ data, sessionId }: { data: string; sessionId: number }) => {
        if (!captureRunning || shutdownStarted) return;
        try {
          const frame = Buffer.from(data, 'base64');
          streamer?.writeFrame(frame);
          await cdpSession?.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
        } catch {
          // Ignore transient screencast ack issues
        }
      });

      await cdpSession.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 85,
        maxWidth: config.WIDTH,
        maxHeight: config.HEIGHT,
        everyNthFrame: 1
      });

      while (captureRunning && !shutdownStarted) {
        if (!page || page.isClosed()) throw new Error('Headless renderer page closed');
        await sleep(500);
      }
    })().catch((error: unknown) => fail(error));

    const runSeconds = mode === 'test' ? config.TEST_DURATION_SECONDS : config.STREAM_DURATION_SECONDS;
    if (runSeconds > 0) {
      const stopTimer = setTimeout(() => {
        shutdownReason = 'configured stream duration reached';
        void shutdown();
      }, runSeconds * 1_000);
      intervals.push(stopTimer);
    }
  } catch (error) {
    fail(error);
  }
}

run().catch((error: unknown) => {
  const secret = process.env.YOUTUBE_RTMPS_URL ?? '';
  const safe = redactedError(error, secret);
  console.error(`Startup failed: ${safe.message}`);
  process.exitCode = 1;
});
