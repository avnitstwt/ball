import BetterSqlite3 from 'better-sqlite3';
import type { GameState, SessionSummary } from './game.js';

export class GameDatabase {
  private readonly database: BetterSqlite3.Database;
  private readonly insertSessionStatement: BetterSqlite3.Statement;
  private readonly insertCheckpointStatement: BetterSqlite3.Statement;
  private readonly completeSessionStatement: BetterSqlite3.Statement;
  private readonly upsertBestStatement: BetterSqlite3.Statement;
  private readonly getBestStatement: BetterSqlite3.Statement;
  private readonly completeTransaction: (summary: SessionSummary, state: GameState) => void;
  private closed = false;

  public constructor(databasePath: string) {
    this.database = new BetterSqlite3(databasePath, { timeout: 5_000 });
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('synchronous = NORMAL');
    this.database.pragma('busy_timeout = 5000');
    this.database.pragma('foreign_keys = ON');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        seed TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL,
        final_score INTEGER NOT NULL DEFAULT 0 CHECK(final_score >= 0),
        best_score INTEGER NOT NULL DEFAULT 0 CHECK(best_score >= 0),
        balls_dropped INTEGER NOT NULL DEFAULT 0 CHECK(balls_dropped >= 0),
        total_merges INTEGER NOT NULL DEFAULT 0 CHECK(total_merges >= 0),
        highest_tier INTEGER NOT NULL DEFAULT 0 CHECK(highest_tier >= 0),
        longest_combo INTEGER NOT NULL DEFAULT 0 CHECK(longest_combo >= 0),
        recoveries INTEGER NOT NULL DEFAULT 0 CHECK(recoveries >= 0),
        game_over_reason TEXT NOT NULL DEFAULT '',
        duration_seconds REAL NOT NULL DEFAULT 0 CHECK(duration_seconds >= 0)
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        session_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        score INTEGER NOT NULL CHECK(score >= 0),
        elapsed_seconds REAL NOT NULL CHECK(elapsed_seconds >= 0),
        state_json TEXT NOT NULL,
        PRIMARY KEY (session_id, recorded_at),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS checkpoints_session_time
      ON checkpoints(session_id, recorded_at);
    `);

    this.insertSessionStatement = this.database.prepare(`
      INSERT INTO sessions (session_id, seed, started_at, status, best_score)
      VALUES (@sessionId, @seed, @startedAt, 'RUNNING', @bestScore)
      ON CONFLICT(session_id) DO NOTHING
    `);
    this.insertCheckpointStatement = this.database.prepare(`
      INSERT OR REPLACE INTO checkpoints (session_id, recorded_at, score, elapsed_seconds, state_json)
      VALUES (@sessionId, @recordedAt, @score, @elapsedSeconds, @stateJson)
    `);
    this.completeSessionStatement = this.database.prepare(`
      UPDATE sessions SET
        ended_at = @endTime,
        status = @status,
        final_score = @finalScore,
        best_score = @bestScore,
        balls_dropped = @ballsDropped,
        total_merges = @totalMerges,
        highest_tier = @highestTierReached,
        longest_combo = @longestCombo,
        recoveries = @recoveries,
        game_over_reason = @gameOverReason,
        duration_seconds = @durationSeconds
      WHERE session_id = @sessionId
    `);
    this.upsertBestStatement = this.database.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ('best_score', @value, @updatedAt)
      ON CONFLICT(key) DO UPDATE SET
        value = CASE
          WHEN CAST(excluded.value AS INTEGER) > CAST(settings.value AS INTEGER) THEN excluded.value
          ELSE settings.value
        END,
        updated_at = excluded.updated_at
    `);
    this.getBestStatement = this.database.prepare(`SELECT value FROM settings WHERE key = 'best_score'`);
    this.completeTransaction = this.database.transaction((summary: SessionSummary, state: GameState) => {
      this.completeSessionStatement.run(summary);
      this.upsertBestStatement.run({ value: String(summary.bestScore), updatedAt: summary.endTime });
      this.insertCheckpoint(state, summary.endTime);
    });
  }

  public getBestScore(): number {
    this.assertOpen();
    const row = this.getBestStatement.get() as { value: string } | undefined;
    if (!row) return 0;
    const value = Number.parseInt(row.value, 10);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  public beginSession(state: GameState): void {
    this.assertOpen();
    this.insertSessionStatement.run({
      sessionId: state.sessionId,
      seed: state.seed,
      startedAt: new Date().toISOString(),
      bestScore: state.bestScore
    });
  }

  public checkpoint(state: GameState): void {
    this.assertOpen();
    this.insertCheckpoint(state, new Date().toISOString());
  }

  private insertCheckpoint(state: GameState, recordedAt: string): void {
    this.insertCheckpointStatement.run({
      sessionId: state.sessionId,
      recordedAt,
      score: state.score,
      elapsedSeconds: state.elapsedSeconds,
      stateJson: JSON.stringify(state)
    });
  }

  public completeSession(summary: SessionSummary, state: GameState): void {
    this.assertOpen();
    this.completeTransaction(summary, state);
  }

  public verifyAccess(): void {
    this.assertOpen();
    this.database.prepare('SELECT 1 AS ok').get();
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.pragma('wal_checkpoint(TRUNCATE)');
    this.database.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SQLite database is already closed');
  }
}
