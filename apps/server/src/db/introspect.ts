/** Plain-object description of the Drizzle schema (used by tests and docs tooling). */
import { getTableName, is } from 'drizzle-orm';
import { MySqlColumn, getTableConfig } from 'drizzle-orm/mysql-core';
import { SCHEMA_TABLES, type SchemaTableName } from './schema';

export interface ColumnDescription {
  name: string;
  sqlType: string;
  notNull: boolean;
  hasDefault: boolean;
  primary: boolean;
  unique: boolean;
}

export interface TableDescription {
  name: string;
  columns: ColumnDescription[];
  indexes: Array<{ name: string; columns: string[]; unique: boolean }>;
  primaryKey: string[];
  foreignKeys: Array<{ columns: string[]; foreignTable: string; foreignColumns: string[] }>;
}

export function describeTable(key: SchemaTableName): TableDescription {
  const config = getTableConfig(SCHEMA_TABLES[key]);
  const columns = config.columns.map((c) => ({
    name: c.name,
    sqlType: c.getSQLType(),
    notNull: c.notNull,
    hasDefault: c.hasDefault,
    primary: c.primary,
    unique: c.isUnique,
  }));
  const singlePk = config.columns.filter((c) => c.primary).map((c) => c.name);
  const compositePk = config.primaryKeys[0]?.columns.map((c) => c.name) ?? [];
  return {
    name: config.name,
    columns,
    indexes: config.indexes.map((idx) => ({
      name: idx.config.name,
      columns: idx.config.columns.map((c) => (is(c, MySqlColumn) ? c.name : '<sql>')),
      unique: idx.config.unique ?? false,
    })),
    primaryKey: compositePk.length > 0 ? compositePk : singlePk,
    foreignKeys: config.foreignKeys.map((fk) => {
      const ref = fk.reference();
      return {
        columns: ref.columns.map((c) => c.name),
        foreignTable: getTableName(ref.foreignTable),
        foreignColumns: ref.foreignColumns.map((c) => c.name),
      };
    }),
  };
}

export function describeSchema(): Record<SchemaTableName, TableDescription> {
  return Object.fromEntries(
    (Object.keys(SCHEMA_TABLES) as SchemaTableName[]).map((k) => [k, describeTable(k)]),
  ) as Record<SchemaTableName, TableDescription>;
}
