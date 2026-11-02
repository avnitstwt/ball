declare module 'better-sqlite3' {
  namespace BetterSqlite3 {
    interface RunResult {
      readonly changes: number;
      readonly lastInsertRowid: number | bigint;
    }

    interface Statement {
      run(...parameters: unknown[]): RunResult;
      get(...parameters: unknown[]): unknown;
      all(...parameters: unknown[]): readonly unknown[];
    }

    interface Database {
      pragma(source: string): unknown;
      exec(source: string): this;
      prepare(source: string): Statement;
      transaction<Arguments extends unknown[], Result>(
        operation: (...argumentsList: Arguments) => Result
      ): (...argumentsList: Arguments) => Result;
      close(): void;
    }

    interface Options {
      readonly timeout?: number;
      readonly readonly?: boolean;
      readonly fileMustExist?: boolean;
    }
  }

  class BetterSqlite3 implements BetterSqlite3.Database {
    public constructor(filename: string, options?: BetterSqlite3.Options);
    public pragma(source: string): unknown;
    public exec(source: string): this;
    public prepare(source: string): BetterSqlite3.Statement;
    public transaction<Arguments extends unknown[], Result>(
      operation: (...argumentsList: Arguments) => Result
    ): (...argumentsList: Arguments) => Result;
    public close(): void;
  }

  export default BetterSqlite3;
}
