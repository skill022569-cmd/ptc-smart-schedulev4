/**
 * Compile-time guard: every shared row interface in `@ptc/shared` must be mutually assignable
 * with the Drizzle-inferred select row of the matching table. Checked by `tsc --noEmit`;
 * this module has no runtime behaviour.
 */
import type { TableName, TableRowMap } from '@ptc/shared';
import type { SchemaTableName, SchemaTables } from './schema';

type Assert<T extends true> = T;
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type SameKeys<A, B> = MutuallyAssignable<keyof A, keyof B>;

type RowCheck = {
  [K in TableName]: K extends SchemaTableName
    ? MutuallyAssignable<TableRowMap[K], SchemaTables[K]['$inferSelect']> extends true
      ? SameKeys<TableRowMap[K], SchemaTables[K]['$inferSelect']>
      : false
    : false;
};

/** Scenario rows (shared row types) must be insertable as-is by `seed.ts`. */
type InsertCheck = {
  [K in TableName]: K extends SchemaTableName
    ? [TableRowMap[K]] extends [SchemaTables[K]['$inferInsert']]
      ? true
      : false
    : false;
};

type AllTrue<T> = T[keyof T] extends true ? true : false;

export type SchemaMatchesSharedTypes = Assert<AllTrue<RowCheck>>;
export type SharedRowsAreInsertable = Assert<AllTrue<InsertCheck>>;
export type SchemaHasAllTables = Assert<MutuallyAssignable<TableName, SchemaTableName>>;
