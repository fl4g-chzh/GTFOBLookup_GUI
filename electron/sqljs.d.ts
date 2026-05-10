declare module 'sql.js' {
  export type BindParams = Record<string, string | number | null>

  export interface QueryExecResult {
    columns: string[]
    values: Array<Array<string | number | null>>
  }

  export interface Statement {
    bind(params?: BindParams): void
    step(): boolean
    getAsObject(): Record<string, string | number | null>
    run(params?: BindParams): void
    free(): void
  }

  export interface Database {
    exec(sql: string): QueryExecResult[]
    prepare(sql: string): Statement
    export(): Uint8Array
  }

  export interface SqlJsStatic {
    Database: new (data?: Buffer | Uint8Array | ArrayLike<number>) => Database
  }

  export default function initSqlJs(config?: {
    locateFile?: (file: string) => string
  }): Promise<SqlJsStatic>
}
