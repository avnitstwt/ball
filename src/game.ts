import Matter from 'matter-js';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const { Engine, World, Bodies, Body, Composite, Events } = Matter;

export interface GameConfig {
  readonly width: number;
  readonly height: number;
  readonly gameAreaHeight: number;
  readonly photoAreaY: number;
  readonly physicsHz: number;
  readonly gravityY: number;
  readonly autoDropMinMs: number;
  readonly autoDropMaxMs: number;
  readonly autoHesitationChance: number;
  readonly autoRiskChance: number;
  readonly minGameDurationSeconds: number;
  readonly maxGameDurationSeconds: number;
  readonly gameRestartMinSeconds: number;
  readonly gameRestartMaxSeconds: number;
  readonly maxActiveBalls: number;
  readonly maxParticles: number;
  readonly mergeContactMs: number;
  readonly recoveryEnabled: boolean;
  readonly initialSeed: string;
  readonly testMode: boolean;
  readonly testDurationSeconds: number;
  readonly streamTitle: string;
  readonly qrX: number;
  readonly qrY: number;
  readonly qrWidth: number;
  readonly qrPadding: number;
  readonly qrLabel: string;
  readonly personPhotoFit: 'cover' | 'contain';
  readonly development: boolean;
  readonly showDevelopmentGuides: boolean;
  readonly musicVolume?: number;
}

export interface TierDefinition {
  readonly name: string;
  readonly radius: number;
  readonly color: string;
  readonly accent: string;
  readonly score: number;
  readonly particle: string;
  readonly pattern: 'dot' | 'ring' | 'stars' | 'stripe' | 'sun' | 'leaf' | 'diamond' | 'rainbow';
}

export const TIERS: readonly TierDefinition[] = [
  { name: 'Mint Dot', radius: 24, color: '#62f0bc', accent: '#164e45', score: 10, particle: '#8affd4', pattern: 'dot' },
  { name: 'Sky Pop', radius: 32, color: '#63c7ff', accent: '#16436a', score: 24, particle: '#a8e6ff', pattern: 'ring' },
  { name: 'Grape Orb', radius: 42, color: '#a979ff', accent: '#4e287c', score: 48, particle: '#d8c2ff', pattern: 'stars' },
  { name: 'Coral Bubble', radius: 54, color: '#ff7f76', accent: '#7d2e36', score: 90, particle: '#ffbbb2', pattern: 'stripe' },
  { name: 'Golden Bounce', radius: 68, color: '#ffc64b', accent: '#75500d', score: 160, particle: '#ffe39a', pattern: 'sun' },
  { name: 'Lime Planet', radius: 84, color: '#a8e95f', accent: '#3d6620', score: 280, particle: '#d7ffad', pattern: 'leaf' },
  { name: 'Violet Giant', radius: 103, color: '#8c70ef', accent: '#39287b', score: 480, particle: '#c9baff', pattern: 'diamond' },
  { name: 'Rainbow Core', radius: 126, color: '#f4f5ff', accent: '#5b4bd9', score: 900, particle: '#ffffff', pattern: 'rainbow' }
] as const;

interface BallRecord {
  readonly body: Matter.Body;
  readonly tier: number;
  readonly createdAtMs: number;
}

interface Particle {
  readonly id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  readonly maxLife: number;
  readonly size: number;
  readonly color: string;
}

interface FloatingLabel {
  readonly id: number;
  readonly text: string;
  readonly x: number;
  y: number;
  life: number;
  readonly color: string;
}

export interface RenderBall {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly vx: number;
  readonly vy: number;
  readonly tier: number;
}

export interface RenderParticle {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly lifeRatio: number;
  readonly size: number;
  readonly color: string;
}

export interface RenderLabel {
  readonly id: number;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly lifeRatio: number;
  readonly color: string;
}

export interface GameState {
  readonly type: 'state';
  readonly sessionId: string;
  readonly seed: string;
  readonly score: number;
  readonly bestScore: number;
  readonly elapsedSeconds: number;
  readonly level: number;
  readonly stage: string;
  readonly nextTier: number;
  readonly balls: readonly RenderBall[];
  readonly particles: readonly RenderParticle[];
  readonly labels: readonly RenderLabel[];
  readonly ballsDropped: number;
  readonly totalMerges: number;
  readonly highestTierReached: number;
  readonly longestCombo: number;
  readonly recoveries: number;
  readonly restarts: number;
  readonly paused: boolean;
  readonly gameOver: boolean;
  readonly overlayText: string;
  readonly statusText: string;
  readonly guides: boolean;
  readonly layout: {
    readonly width: number;
    readonly height: number;
    readonly gameAreaHeight: number;
    readonly photoAreaY: number;
    readonly qrX: number;
    readonly qrY: number;
    readonly qrWidth: number;
    readonly qrPadding: number;
    readonly qrLabel: string;
    readonly personPhotoFit: 'cover' | 'contain';
    readonly streamTitle: string;
    readonly musicVolume?: number;
  };
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly seed: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly status: 'COMPLETED' | 'FAILED' | 'INTERRUPTED';
  readonly durationSeconds: number;
  readonly finalScore: number;
  readonly bestScore: number;
  readonly ballsDropped: number;
  readonly totalMerges: number;
  readonly highestTierReached: number;
  readonly longestCombo: number;
  readonly recoveries: number;
  readonly gameOverReason: string;
  readonly restarts: number;
}

export interface GameCallbacks {
  readonly onSessionStart: (state: GameState) => void;
  readonly onCheckpoint: (state: GameState) => void;
  readonly onSessionEnd: (summary: SessionSummary, finalState: GameState) => void;
}

class SeededRandom {
  private state: number;

  public constructor(seedText: string) {
    let hash = 2166136261;
    for (const character of seedText) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    this.state = hash >>> 0 || 0x9e3779b9;
  }

  public next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }

  public between(minimum: number, maximum: number): number {
    return minimum + (maximum - minimum) * this.next();
  }

  public integer(minimum: number, maximumInclusive: number): number {
    return Math.floor(this.between(minimum, maximumInclusive + 1));
  }

  public chance(probability: number): boolean {
    return this.next() < probability;
  }
}

function createSeed(): string {
  return randomBytes(8).toString('hex');
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function pairKey(firstId: number, secondId: number): string {
  return firstId < secondId ? `${firstId}:${secondId}` : `${secondId}:${firstId}`;
}

export class EndlessGame {
  private readonly engine: Matter.Engine;
  private readonly config: GameConfig;
  private readonly callbacks: GameCallbacks;
  private readonly balls = new Map<number, BallRecord>();
  private readonly contactStartedAt = new Map<string, number>();
  private readonly mergeLocks = new Set<number>();
  private readonly pendingMerges: Array<readonly [number, number]> = [];
  private readonly particles: Particle[] = [];
  private readonly labels: FloatingLabel[] = [];
  private rng: SeededRandom;
  private seed: string;
  private sessionId: string;
  private sessionStartedAtIso: string;
  private sessionStartMonotonicMs: number;
  private previousAdvanceMs: number;
  private simulationMs = 0;
  private physicsUpdateCount = 0;
  private accumulatorMs = 0;
  private nextDropAtMs = 0;
  private nextCheckpointAtMs = 60_000;
  private gameOverAtMs = Number.POSITIVE_INFINITY;
  private restartAtMs = Number.POSITIVE_INFINITY;
  private sessionTargetSeconds: number;
  private criticalSinceMs: number | null = null;
  private lastRecoveryAtMs = -120_000;
  private lastMergeAtMs = -10_000;
  private chainCount = 0;
  private nextTier = 0;
  private particleId = 1;
  private labelId = 1;
  private score = 0;
  private bestScore: number;
  private ballsDropped = 0;
  private totalMerges = 0;
  private highestTierReached = 0;
  private longestCombo = 0;
  private recoveries = 0;
  private restarts = 0;
  private paused = true;
  private spawningPaused = false;
  private gameOver = false;
  private sessionEndEmitted = false;
  private overlayText = '';
  private statusText = 'Preparing local game';
  private guides: boolean;
  private testRecoveryTriggered = false;
  private testGameOverTriggered = false;
  private testMergesForced = 0;
  private nextSurvivalBonusAtMs: number;

  public constructor(config: GameConfig, bestScore: number, callbacks: GameCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
    this.bestScore = bestScore;
    this.seed = config.initialSeed.trim() || createSeed();
    this.rng = new SeededRandom(this.seed);
    this.sessionId = this.makeSessionId();
    this.sessionStartedAtIso = new Date().toISOString();
    this.sessionStartMonotonicMs = performance.now();
    this.previousAdvanceMs = this.sessionStartMonotonicMs;
    this.sessionTargetSeconds = this.chooseSessionTarget();
    this.nextSurvivalBonusAtMs = config.testMode ? 12_000 : 600_000;
    this.guides = config.development && config.showDevelopmentGuides;

    this.engine = Engine.create({ enableSleeping: true });
    this.engine.gravity.x = 0;
    this.engine.gravity.y = config.gravityY;
    this.engine.gravity.scale = 0.001;
    this.createContainer();

    Events.on(this.engine, 'collisionActive', (event: Matter.IEventCollision<Matter.Engine>) => {
      this.handleCollisionActive(event);
    });
    Events.on(this.engine, 'collisionEnd', (event: Matter.IEventCollision<Matter.Engine>) => {
      for (const pair of event.pairs) {
        this.contactStartedAt.delete(pairKey(pair.bodyA.id, pair.bodyB.id));
      }
    });
  }

  public start(): void {
    if (!this.paused) return;
    this.paused = false;
    this.spawningPaused = false;
    this.previousAdvanceMs = performance.now();
    this.sessionStartMonotonicMs = this.previousAdvanceMs;
    this.nextDropAtMs = 350;
    this.nextTier = this.chooseNextTier();
    this.statusText = this.config.testMode ? 'SAFE LOCAL TEST' : 'LIVE GAME';
    this.callbacks.onSessionStart(this.getState());
  }

  public advance(nowMs = performance.now()): void {
    const rawDelta = nowMs - this.previousAdvanceMs;
    this.previousAdvanceMs = nowMs;
    if (this.paused) return;

    const frameDelta = clamp(rawDelta, 0, 250);
    this.accumulatorMs += frameDelta;
    const fixedStepMs = 1000 / this.config.physicsHz;
    let catchUpSteps = 0;
    while (this.accumulatorMs >= fixedStepMs && catchUpSteps < 8) {
      this.fixedUpdate(fixedStepMs);
      this.accumulatorMs -= fixedStepMs;
      catchUpSteps += 1;
    }
    if (catchUpSteps === 8) this.accumulatorMs = Math.min(this.accumulatorMs, fixedStepMs);
  }

  private fixedUpdate(stepMs: number): void {
    this.physicsUpdateCount += 1;
    this.simulationMs += stepMs;
    if (!this.gameOver) {
      Engine.update(this.engine, stepMs);
      this.processPendingMerges();
      this.updateParticles(stepMs);
      this.cleanOutOfBounds();
      this.applyLongSessionProtection();
      this.runAutoPlayer();
      this.applySurvivalBonus();
      this.runTestScenario();
      this.evaluateGameOver();
    } else {
      Engine.update(this.engine, stepMs);
      this.updateParticles(stepMs);
      if (this.simulationMs >= this.restartAtMs) this.restartSession();
    }

    if (this.simulationMs >= this.nextCheckpointAtMs && !this.gameOver) {
      this.nextCheckpointAtMs += 60_000;
      this.callbacks.onCheckpoint(this.getState());
    }
  }

  private createContainer(): void {
    const wallOptions: Matter.IChamferableBodyDefinition = {
      isStatic: true,
      restitution: 0.25,
      friction: 0.7,
      label: 'container'
    };
    const left = Bodies.rectangle(62, 650, 34, 870, { ...wallOptions, angle: -0.035 });
    const right = Bodies.rectangle(708, 650, 34, 870, { ...wallOptions, angle: 0.035 });
    const floor = Bodies.rectangle(385, 1082, 680, 40, wallOptions);
    World.add(this.engine.world, [left, right, floor]);
  }

  private handleCollisionActive(event: Matter.IEventCollision<Matter.Engine>): void {
    for (const pair of event.pairs) {
      const first = this.balls.get(pair.bodyA.id);
      const second = this.balls.get(pair.bodyB.id);
      if (!first || !second || first.tier !== second.tier) continue;
      if (this.mergeLocks.has(pair.bodyA.id) || this.mergeLocks.has(pair.bodyB.id)) continue;
      const relativeX = pair.bodyA.velocity.x - pair.bodyB.velocity.x;
      const relativeY = pair.bodyA.velocity.y - pair.bodyB.velocity.y;
      const relativeSpeed = Math.hypot(relativeX, relativeY);
      const highStack = this.getHighestBallY() < 330;
      const tolerance = highStack && this.elapsedSeconds() < this.config.minGameDurationSeconds ? 10.5 : 7.5;
      const key = pairKey(pair.bodyA.id, pair.bodyB.id);
      if (relativeSpeed > tolerance) {
        this.contactStartedAt.delete(key);
        continue;
      }
      const startedAt = this.contactStartedAt.get(key) ?? this.simulationMs;
      this.contactStartedAt.set(key, startedAt);
      const requiredContact = highStack ? Math.max(70, this.config.mergeContactMs - 25) : this.config.mergeContactMs;
      if (this.simulationMs - startedAt >= requiredContact) {
        this.mergeLocks.add(pair.bodyA.id);
        this.mergeLocks.add(pair.bodyB.id);
        this.pendingMerges.push([pair.bodyA.id, pair.bodyB.id]);
        this.contactStartedAt.delete(key);
      }
    }
  }

  private processPendingMerges(): void {
    while (this.pendingMerges.length > 0) {
      const merge = this.pendingMerges.shift();
      if (!merge) break;
      this.performMerge(merge[0], merge[1]);
    }
  }

  private performMerge(firstId: number, secondId: number): void {
    const first = this.balls.get(firstId);
    const second = this.balls.get(secondId);
    if (!first || !second || first.tier !== second.tier) {
      this.mergeLocks.delete(firstId);
      this.mergeLocks.delete(secondId);
      return;
    }

    const x = clamp((first.body.position.x + second.body.position.x) / 2, 95, 675);
    const y = clamp((first.body.position.y + second.body.position.y) / 2, 170, 1035);
    const averageVelocityX = (first.body.velocity.x + second.body.velocity.x) / 2;
    this.removeBall(firstId);
    this.removeBall(secondId);

    this.chainCount = this.simulationMs - this.lastMergeAtMs <= 1_600 ? this.chainCount + 1 : 1;
    this.lastMergeAtMs = this.simulationMs;
    this.longestCombo = Math.max(this.longestCombo, this.chainCount);
    const comboMultiplier = clamp(1 + (this.chainCount - 1) * 0.2, 1, 3);
    const isFinalTierBonus = first.tier === TIERS.length - 1;
    const scoreBase = isFinalTierBonus ? TIERS[first.tier]!.score * 4 : TIERS[first.tier]!.score;
    const mergeScore = Math.round(scoreBase * comboMultiplier);
    this.addScore(mergeScore);
    this.totalMerges += 1;

    const particleColor = TIERS[first.tier]!.particle;
    this.emitParticles(x, y, isFinalTierBonus ? 36 : 18 + Math.min(18, this.chainCount * 2), particleColor);
    const comboText = this.chainCount > 1 ? `+${mergeScore}  ${this.chainCount}x CHAIN` : `+${mergeScore}`;
    this.addLabel(comboText, x, y - 20, isFinalTierBonus ? '#fff7a8' : '#ffffff');

    if (!isFinalTierBonus) {
      const mergedTier = first.tier + 1;
      const mergedRadius = TIERS[mergedTier]!.radius;
      const mergedX = clamp(x, 92 + mergedRadius, 682 - mergedRadius);
      const mergedY = clamp(y, 165 + mergedRadius, 1_052 - mergedRadius);
      const body = this.createBallBody(mergedTier, mergedX, mergedY);
      Body.setVelocity(body, { x: averageVelocityX * 0.22, y: -3.2 - Math.min(2.4, this.chainCount * 0.22) });
      this.highestTierReached = Math.max(this.highestTierReached, mergedTier);
    } else {
      this.addLabel('RAINBOW BONUS', x, y + 14, '#fff7a8');
    }
  }

  private addScore(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.score += Math.round(amount);
    this.bestScore = Math.max(this.bestScore, this.score);
  }

  private emitParticles(x: number, y: number, count: number, color: string): void {
    const available = Math.max(0, this.config.maxParticles - this.particles.length);
    const actualCount = Math.min(count, available);
    for (let index = 0; index < actualCount; index += 1) {
      const angle = this.rng.between(0, Math.PI * 2);
      const speed = this.rng.between(1.2, 6.5);
      const life = this.rng.between(420, 950);
      this.particles.push({
        id: this.particleId++,
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1.5,
        life,
        maxLife: life,
        size: this.rng.between(3, 9),
        color
      });
    }
  }

  private addLabel(text: string, x: number, y: number, color: string): void {
    if (this.labels.length >= 36) this.labels.shift();
    this.labels.push({ id: this.labelId++, text, x, y, life: 1_250, color });
  }

  private updateParticles(stepMs: number): void {
    const scale = stepMs / 16.6667;
    for (const particle of this.particles) {
      particle.x += particle.vx * scale;
      particle.y += particle.vy * scale;
      particle.vy += 0.12 * scale;
      particle.vx *= 0.988;
      particle.life -= stepMs;
    }
    for (let index = this.particles.length - 1; index >= 0; index -= 1) {
      if (this.particles[index]!.life <= 0) this.particles.splice(index, 1);
    }
    for (const label of this.labels) {
      label.y -= 0.55 * scale;
      label.life -= stepMs;
    }
    for (let index = this.labels.length - 1; index >= 0; index -= 1) {
      if (this.labels[index]!.life <= 0) this.labels.splice(index, 1);
    }
  }

  private runAutoPlayer(): void {
    if (this.spawningPaused || this.gameOver || this.simulationMs < this.nextDropAtMs) return;
    if (this.balls.size >= this.config.maxActiveBalls) {
      this.statusText = 'Stability hold';
      this.nextDropAtMs = this.simulationMs + 2_500;
      return;
    }

    const tier = this.nextTier;
    const radius = TIERS[tier]!.radius;
    const x = this.chooseDropX(tier, radius);
    if (this.isSpawnBlocked(x, radius)) {
      this.nextDropAtMs = this.simulationMs + this.rng.between(500, 1_100);
      return;
    }

    this.createBallBody(tier, x, 145 + radius);
    this.ballsDropped += 1;
    this.highestTierReached = Math.max(this.highestTierReached, tier);
    this.nextTier = this.chooseNextTier();
    this.scheduleNextDrop();
  }

  private chooseDropX(tier: number, radius: number): number {
    const minimumX = 92 + radius;
    const maximumX = 680 - radius;
    const compatible = [...this.balls.values()]
      .filter((ball) => ball.tier === tier && ball.body.position.y > 260)
      .sort((first, second) => second.body.position.y - first.body.position.y);
    const stackHigh = this.getHighestBallY() < 400;
    const risky = this.rng.chance(this.config.autoRiskChance) && !stackHigh;

    if (!risky && compatible.length > 0) {
      const targetWindow = Math.min(4, compatible.length);
      const target = compatible[this.rng.integer(0, targetWindow - 1)];
      if (target) return clamp(target.body.position.x + this.rng.between(-18, 18), minimumX, maximumX);
    }

    const columns = 9;
    const scores: number[] = [];
    for (let column = 0; column < columns; column += 1) {
      const x = minimumX + (column / (columns - 1)) * (maximumX - minimumX);
      let crowding = 0;
      for (const ball of this.balls.values()) {
        const distance = Math.abs(ball.body.position.x - x);
        if (distance < 90) crowding += (1 - distance / 90) * (1_150 - ball.body.position.y) / 950;
      }
      scores.push(crowding + this.rng.between(0, 0.12));
    }
    const safestIndex = scores.indexOf(Math.min(...scores));
    const selectedIndex = risky ? this.rng.integer(0, columns - 1) : safestIndex;
    const baseX = minimumX + (selectedIndex / (columns - 1)) * (maximumX - minimumX);
    return clamp(baseX + this.rng.between(-22, 22), minimumX, maximumX);
  }

  private scheduleNextDrop(): void {
    let delay = this.rng.between(this.config.autoDropMinMs, this.config.autoDropMaxMs);
    const highStack = this.getHighestBallY() < 420;
    if (highStack) delay *= 1.3;
    if (this.rng.chance(this.config.autoHesitationChance)) delay += this.rng.between(600, 1_800);
    if (!highStack && this.rng.chance(0.065)) delay = this.rng.between(480, 820);
    this.nextDropAtMs = this.simulationMs + delay;
  }

  private chooseNextTier(): number {
    const highStack = this.getHighestBallY() < 430;
    const roll = this.rng.next();
    if (highStack) return roll < 0.68 ? 0 : roll < 0.93 ? 1 : 2;
    if (roll < 0.49) return 0;
    if (roll < 0.78) return 1;
    if (roll < 0.94) return 2;
    return 3;
  }

  private isSpawnBlocked(x: number, radius: number): boolean {
    for (const ball of this.balls.values()) {
      if (ball.body.position.y > 320) continue;
      const minimumDistance = radius + TIERS[ball.tier]!.radius + 12;
      if (Math.hypot(ball.body.position.x - x, ball.body.position.y - (145 + radius)) < minimumDistance) return true;
    }
    return false;
  }

  private createBallBody(tier: number, x: number, y: number): Matter.Body {
    const definition = TIERS[tier];
    if (!definition) throw new Error(`Invalid tier ${tier}`);
    const body = Bodies.circle(x, y, definition.radius, {
      restitution: 0.28,
      friction: 0.42,
      frictionStatic: 0.62,
      frictionAir: 0.012,
      density: 0.0016 + tier * 0.00012,
      slop: 0.02,
      label: `ball-tier-${tier}`
    });
    this.balls.set(body.id, { body, tier, createdAtMs: this.simulationMs });
    World.add(this.engine.world, body);
    return body;
  }

  private removeBall(id: number): void {
    const record = this.balls.get(id);
    if (!record) return;
    World.remove(this.engine.world, record.body);
    this.balls.delete(id);
    this.mergeLocks.delete(id);
    for (const key of this.contactStartedAt.keys()) {
      if (key.startsWith(`${id}:`) || key.endsWith(`:${id}`)) this.contactStartedAt.delete(key);
    }
  }

  private cleanOutOfBounds(): void {
    for (const ball of [...this.balls.values()]) {
      const { x, y } = ball.body.position;
      if (x < -250 || x > this.config.width + 250 || y > this.config.height + 300 || y < -350) {
        this.removeBall(ball.body.id);
      }
    }
    if (this.balls.size > this.config.maxActiveBalls) {
      const overflow = this.balls.size - this.config.maxActiveBalls;
      const candidates = [...this.balls.values()]
        .filter((ball) => ball.tier <= 1)
        .sort((first, second) => second.body.position.y - first.body.position.y)
        .slice(0, Math.min(overflow, 3));
      for (const ball of candidates) this.removeBall(ball.body.id);
    }
  }

  private applyLongSessionProtection(): void {
    const highestY = this.getHighestBallY();
    const elapsed = this.elapsedSeconds();
    const beforeMinimum = elapsed < this.config.minGameDurationSeconds;
    if (highestY < 360) {
      if (this.criticalSinceMs === null) this.criticalSinceMs = this.simulationMs;
      if (beforeMinimum) {
        for (const ball of this.balls.values()) {
          if (ball.body.position.y < 520 && ball.body.speed < 1.1) {
            const centerPull = (385 - ball.body.position.x) * 0.0000007;
            Body.applyForce(ball.body, ball.body.position, { x: centerPull, y: 0.000004 });
          }
        }
        if (
          this.config.recoveryEnabled &&
          highestY < 285 &&
          this.simulationMs - this.lastRecoveryAtMs > 75_000 &&
          this.criticalSinceMs !== null &&
          this.simulationMs - this.criticalSinceMs > 7_000
        ) {
          this.triggerRecovery('Stability Bonus');
        }
      }
    } else {
      this.criticalSinceMs = null;
      this.statusText = this.config.testMode ? 'SAFE LOCAL TEST' : 'LIVE GAME';
    }

    if (Math.floor(this.simulationMs) % 3_000 < 17) this.resolveStuckBalls();
  }

  private resolveStuckBalls(): void {
    for (const ball of this.balls.values()) {
      if (ball.body.speed < 0.025 && ball.body.position.y < 960 && this.simulationMs - ball.createdAtMs > 8_000) {
        const direction = ball.body.position.x < 385 ? 1 : -1;
        Body.applyForce(ball.body, ball.body.position, { x: direction * 0.000006, y: -0.000003 });
      }
    }
  }

  public triggerRecovery(label = 'Stability Bonus'): void {
    if (!this.config.recoveryEnabled || this.gameOver) return;
    const candidates = [...this.balls.values()]
      .filter((ball) => ball.tier <= 1 && ball.body.position.y > 720)
      .sort((first, second) => second.body.position.y - first.body.position.y)
      .slice(0, 3);
    if (candidates.length === 0) {
      const fallback = [...this.balls.values()]
        .filter((ball) => ball.tier === 0)
        .sort((first, second) => second.body.position.y - first.body.position.y)
        .slice(0, 1);
      candidates.push(...fallback);
    }
    if (candidates.length === 0) return;

    let points = 0;
    let centerX = 0;
    let centerY = 0;
    for (const ball of candidates) {
      points += Math.max(5, Math.round(TIERS[ball.tier]!.score * 0.5));
      centerX += ball.body.position.x;
      centerY += ball.body.position.y;
      this.removeBall(ball.body.id);
    }
    centerX /= candidates.length;
    centerY /= candidates.length;
    this.addScore(points);
    this.recoveries += 1;
    this.lastRecoveryAtMs = this.simulationMs;
    this.statusText = label;
    this.addLabel(`${label} +${points}`, centerX, centerY, '#a8ffd9');
    this.emitParticles(centerX, centerY, 22, '#82ffd1');
  }

  private evaluateGameOver(): void {
    const elapsed = this.elapsedSeconds();
    const pastTarget = elapsed >= this.sessionTargetSeconds;
    const criticalAfterMinimum =
      elapsed >= this.config.minGameDurationSeconds &&
      this.criticalSinceMs !== null &&
      this.simulationMs - this.criticalSinceMs > 8_000;
    if (pastTarget || criticalAfterMinimum) {
      this.beginGameOver(pastTarget ? 'scheduled session complete' : 'critical stack');
    }
  }

  private runTestScenario(): void {
    if (!this.config.testMode) return;
    const elapsed = this.elapsedSeconds();
    const mergeTimes = [2, 4, 6, 8];
    const nextMergeTime = mergeTimes[this.testMergesForced];
    if (nextMergeTime !== undefined && elapsed > nextMergeTime) {
      this.forceSafeMerge();
      this.testMergesForced += 1;
    }
    if (elapsed > 9 && !this.testRecoveryTriggered) {
      this.ensureRecoveryCandidates();
      this.triggerRecovery('Stability Bonus');
      this.testRecoveryTriggered = true;
    }
    const restartAt = Math.min(32, Math.max(14, this.config.testDurationSeconds * 0.42));
    if (elapsed > restartAt && !this.testGameOverTriggered) {
      this.testGameOverTriggered = true;
      this.beginGameOver('accelerated test restart');
    }
  }

  private applySurvivalBonus(): void {
    if (this.simulationMs < this.nextSurvivalBonusAtMs || this.gameOver) return;
    const interval = this.config.testMode ? 12_000 : 600_000;
    this.nextSurvivalBonusAtMs += interval;
    const points = 40 + Math.min(460, Math.floor(this.elapsedSeconds() / 600) * 20);
    this.addScore(points);
    this.addLabel(`SURVIVAL +${points}`, 385, 265, '#9ce8ff');
    this.emitParticles(385, 285, 16, '#9ce8ff');
  }

  private ensureRecoveryCandidates(): void {
    if ([...this.balls.values()].some((ball) => ball.tier <= 1 && ball.body.position.y > 720)) return;
    const body = this.createBallBody(0, 310, 990);
    Body.setVelocity(body, { x: 0, y: 0 });
  }

  private beginGameOver(reason: string): void {
    if (this.gameOver) return;
    this.gameOver = true;
    this.spawningPaused = true;
    this.gameOverAtMs = this.simulationMs;
    this.restartAtMs = this.simulationMs + this.rng.between(
      this.config.gameRestartMinSeconds * 1_000,
      this.config.gameRestartMaxSeconds * 1_000
    );
    this.overlayText = 'SESSION COMPLETE';
    this.statusText = 'Next session is preparing';
    if (!this.sessionEndEmitted) {
      this.sessionEndEmitted = true;
      const state = this.getState();
      this.callbacks.onSessionEnd(this.buildSummary('COMPLETED', reason), state);
    }
  }

  private restartSession(): void {
    for (const ball of [...this.balls.values()]) this.removeBall(ball.body.id);
    this.particles.length = 0;
    this.labels.length = 0;
    this.contactStartedAt.clear();
    this.pendingMerges.length = 0;
    this.mergeLocks.clear();

    this.restarts += 1;
    this.seed = createSeed();
    this.rng = new SeededRandom(this.seed);
    this.sessionId = this.makeSessionId();
    this.sessionStartedAtIso = new Date().toISOString();
    this.sessionStartMonotonicMs = performance.now();
    this.simulationMs = 0;
    this.accumulatorMs = 0;
    this.previousAdvanceMs = this.sessionStartMonotonicMs;
    this.nextCheckpointAtMs = 60_000;
    this.score = 0;
    this.ballsDropped = 0;
    this.totalMerges = 0;
    this.highestTierReached = 0;
    this.longestCombo = 0;
    this.recoveries = 0;
    this.chainCount = 0;
    this.lastMergeAtMs = -10_000;
    this.lastRecoveryAtMs = -120_000;
    this.criticalSinceMs = null;
    this.gameOver = false;
    this.sessionEndEmitted = false;
    this.overlayText = '';
    this.statusText = this.config.testMode ? 'SAFE LOCAL TEST' : 'LIVE GAME';
    this.testRecoveryTriggered = false;
    this.testGameOverTriggered = false;
    this.testMergesForced = 0;
    this.nextSurvivalBonusAtMs = this.config.testMode ? 12_000 : 600_000;
    this.sessionTargetSeconds = this.chooseSessionTarget();
    this.nextTier = this.chooseNextTier();
    this.nextDropAtMs = 600;
    this.callbacks.onSessionStart(this.getState());
  }

  private chooseSessionTarget(): number {
    if (this.config.testMode) return Math.min(45, Math.max(18, this.config.testDurationSeconds * 0.5));
    return this.rng.between(this.config.minGameDurationSeconds, this.config.maxGameDurationSeconds);
  }

  private makeSessionId(): string {
    return `session-${Date.now()}-${this.seed.slice(0, 8)}`;
  }

  private elapsedSeconds(): number {
    if (this.gameOver && Number.isFinite(this.gameOverAtMs)) return this.gameOverAtMs / 1_000;
    return this.simulationMs / 1_000;
  }

  private getHighestBallY(): number {
    let highest = Number.POSITIVE_INFINITY;
    for (const ball of this.balls.values()) {
      highest = Math.min(highest, ball.body.position.y - TIERS[ball.tier]!.radius);
    }
    return highest;
  }

  public getState(): GameState {
    const elapsed = this.elapsedSeconds();
    return {
      type: 'state',
      sessionId: this.sessionId,
      seed: this.seed,
      score: this.score,
      bestScore: this.bestScore,
      elapsedSeconds: elapsed,
      level: Math.min(99, 1 + Math.floor(elapsed / 300)),
      stage: this.getStageName(elapsed),
      nextTier: this.nextTier,
      balls: [...this.balls.values()].map((ball) => ({
        id: ball.body.id,
        x: ball.body.position.x,
        y: ball.body.position.y,
        angle: ball.body.angle,
        vx: ball.body.velocity.x,
        vy: ball.body.velocity.y,
        tier: ball.tier
      })),
      particles: this.particles.map((particle) => ({
        id: particle.id,
        x: particle.x,
        y: particle.y,
        lifeRatio: clamp(particle.life / particle.maxLife, 0, 1),
        size: particle.size,
        color: particle.color
      })),
      labels: this.labels.map((label) => ({
        id: label.id,
        text: label.text,
        x: label.x,
        y: label.y,
        lifeRatio: clamp(label.life / 1_250, 0, 1),
        color: label.color
      })),
      ballsDropped: this.ballsDropped,
      totalMerges: this.totalMerges,
      highestTierReached: this.highestTierReached,
      longestCombo: this.longestCombo,
      recoveries: this.recoveries,
      restarts: this.restarts,
      paused: this.paused,
      gameOver: this.gameOver,
      overlayText: this.overlayText,
      statusText: this.statusText,
      guides: this.guides,
      layout: {
        width: this.config.width,
        height: this.config.height,
        gameAreaHeight: this.config.gameAreaHeight,
        photoAreaY: this.config.photoAreaY,
        qrX: this.config.qrX,
        qrY: this.config.qrY,
        qrWidth: this.config.qrWidth,
        qrPadding: this.config.qrPadding,
        qrLabel: this.config.qrLabel,
        personPhotoFit: this.config.personPhotoFit,
        streamTitle: this.config.streamTitle,
        musicVolume: this.config.musicVolume ?? 0.08
      }
    };
  }

  public getPhysicsUpdateCount(): number {
    return this.physicsUpdateCount;
  }

  private getStageName(elapsed: number): string {
    if (elapsed < 600) return 'Fresh Orbit';
    if (elapsed < 1_800) return 'Merge Flow';
    if (elapsed < 3_600) return 'Deep Drop';
    if (elapsed < 7_200) return 'Long Run';
    return 'Endless Core';
  }

  public pause(): void {
    this.paused = true;
    this.statusText = 'Paused locally';
  }

  public resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.previousAdvanceMs = performance.now();
    this.statusText = this.config.testMode ? 'SAFE LOCAL TEST' : 'LIVE GAME';
  }

  public pauseSpawning(reason: string): void {
    this.spawningPaused = true;
    this.statusText = reason;
  }

  public spawnNextBall(): void {
    if (this.gameOver || this.balls.size >= this.config.maxActiveBalls) return;
    const tier = this.nextTier;
    const radius = TIERS[tier]!.radius;
    this.createBallBody(tier, this.chooseDropX(tier, radius), 145 + radius);
    this.ballsDropped += 1;
    this.nextTier = this.chooseNextTier();
  }

  public forceSafeMerge(): void {
    if (this.gameOver || this.balls.size > this.config.maxActiveBalls - 2) return;
    const tier = this.rng.integer(0, 3);
    const x = this.rng.between(210, 560);
    const y = this.rng.between(360, 640);
    const first = this.createBallBody(tier, x - TIERS[tier]!.radius * 0.72, y);
    const second = this.createBallBody(tier, x + TIERS[tier]!.radius * 0.72, y);
    Body.setVelocity(first, { x: 0.35, y: 0 });
    Body.setVelocity(second, { x: -0.35, y: 0 });
    this.ballsDropped += 2;
  }

  public testGameOver(): void {
    this.beginGameOver('manual development test');
  }

  public resetSession(): void {
    if (!this.gameOver && !this.sessionEndEmitted) {
      this.sessionEndEmitted = true;
      const state = this.getState();
      this.callbacks.onSessionEnd(this.buildSummary('INTERRUPTED', 'manual reset'), state);
    }
    this.gameOver = true;
    this.restartAtMs = this.simulationMs;
    this.restartSession();
  }

  public toggleGuides(): void {
    if (this.config.development) this.guides = !this.guides;
  }

  public setBestScore(bestScore: number): void {
    this.bestScore = Math.max(this.bestScore, bestScore);
  }

  public buildSummary(status: 'COMPLETED' | 'FAILED' | 'INTERRUPTED', reason: string): SessionSummary {
    return {
      sessionId: this.sessionId,
      seed: this.seed,
      startTime: this.sessionStartedAtIso,
      endTime: new Date().toISOString(),
      status,
      durationSeconds: Math.round(this.elapsedSeconds() * 100) / 100,
      finalScore: this.score,
      bestScore: this.bestScore,
      ballsDropped: this.ballsDropped,
      totalMerges: this.totalMerges,
      highestTierReached: this.highestTierReached,
      longestCombo: this.longestCombo,
      recoveries: this.recoveries,
      gameOverReason: reason,
      restarts: this.restarts
    };
  }

  public destroy(): void {
    (Events as any).off(this.engine);
    Composite.clear(this.engine.world, false, true);
    Engine.clear(this.engine);
    this.balls.clear();
    this.particles.length = 0;
    this.labels.length = 0;
    this.contactStartedAt.clear();
    this.mergeLocks.clear();
    this.pendingMerges.length = 0;
  }
}
