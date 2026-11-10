import { StoredObjectDataTableMetadata, StoredObjectMetadata } from "@concord-consortium/object-storage";

const kSnapshotSubType = "multi-value-snapshot";
export const kSnapshotIndexItemId = "tables";
export const kObjectIdAttr = "__objectId";
const kReservedCols = [kObjectIdAttr, "__id__", "__proto__"];

const kColTypes = ["categorical", "numeric"] as const;
type ColType = typeof kColTypes[number];

export interface SnapshotTable {
  id: string;
  name: string;
  cols: string[];
  colTypes: ColType[];
}

export const isSnapshot = (metadata: StoredObjectMetadata) => metadata.subType === kSnapshotSubType;

const isColType = (value: unknown): value is ColType => kColTypes.includes(value as ColType);

const parseTable = (metadata: StoredObjectMetadata, entry: any): SnapshotTable => {
  if (typeof entry?.id !== "string") {
    throw new Error("The index has a table with no valid id.");
  }
  const item = metadata.items[entry.id];
  if (item?.type !== "dataTable") {
    throw new Error(`The index names "${entry.id}", which is not a data table.`);
  }
  const { name, cols } = item as StoredObjectDataTableMetadata;
  if (typeof name !== "string") {
    throw new Error(`The index names "${entry.id}", which has no table name.`);
  }
  if (!Array.isArray(cols)) {
    throw new Error(`Table "${name}" has no column list.`);
  }
  if (!cols.every(col => typeof col === "string")) {
    throw new Error(`Table "${name}" has a column name that is not text.`);
  }
  const { colTypes } = entry;
  if (!Array.isArray(colTypes) || colTypes.length !== cols.length || !colTypes.every(isColType)) {
    throw new Error(`Table "${name}" needs one categorical or numeric colType per column.`);
  }
  if (cols.includes("")) {
    throw new Error(`Table "${name}" has a column with no name.`);
  }
  if (new Set(cols).size !== cols.length) {
    throw new Error(`Table "${name}" repeats a column name.`);
  }
  if (cols.some(col => kReservedCols.includes(col))) {
    throw new Error(`Table "${name}" uses a reserved column name.`);
  }
  return { id: entry.id, name, cols, colTypes };
};

export const parseSnapshotTables = (metadata: StoredObjectMetadata, index: unknown): SnapshotTable[] => {
  const entries = (index as any)?.tables;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("The snapshot has no table index.");
  }
  if (new Set(entries.map(entry => entry?.id)).size !== entries.length) {
    throw new Error("The index names a table twice.");
  }
  return entries.map(entry => parseTable(metadata, entry));
};
