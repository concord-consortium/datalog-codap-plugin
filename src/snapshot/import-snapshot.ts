import {
  codapInterface, createItems, createTable, getAllItems, getItemByIndex, getListOfDataContexts
} from "@concord-consortium/codap-plugin-api";
import { IObjectStorage, StoredObjectMetadata } from "@concord-consortium/object-storage";
import { kObjectIdAttr, kSnapshotIndexItemId, parseSnapshotTables, SnapshotTable } from "./multi-value-snapshot";

const kDatasetPrefix = "DatalogSnapshotTable_";

export const datasetName = (objectId: string, tableIndex: number) => `${kDatasetPrefix}${objectId}_${tableIndex}`;

const isDatasetOf = (dataset: string, objectId: string) => {
  const prefix = `${kDatasetPrefix}${objectId}_`;
  return dataset.startsWith(prefix) && /^\d+$/.test(dataset.slice(prefix.length));
};

const requireSuccess = async (request: Promise<unknown>, what: string) => {
  const result = await request as { success?: boolean } | undefined;
  if (!result?.success) throw new Error(`CODAP refused ${what}.`);
};

const createDataset = async (dataset: string, title: string, table: SnapshotTable) => {
  await requireSuccess(codapInterface.sendRequest({
    action: "create",
    resource: "dataContext",
    values: {
      name: dataset,
      title,
      collections: [
        {
          name: table.name,
          attrs: [
            ...table.cols.map((col, index) => ({ name: col, type: table.colTypes[index] })),
            { name: kObjectIdAttr, type: "categorical", hidden: true }
          ]
        }
      ]
    }
  }), `the table "${title}"`);
};

const deleteDataset = (dataset: string) =>
  codapInterface.sendRequest({ action: "delete", resource: `dataContext[${dataset}]` }).catch(() => undefined);

const deleteSnapshotRows = (dataset: string, objectId: string) =>
  codapInterface.sendRequest({
    action: "delete", resource: `dataContext[${dataset}].itemSearch[${kObjectIdAttr}==${objectId}]`
  }).catch(() => undefined);

export const kLeftoverRows =
  "Some of its rows could not be removed from CODAP. Delete them, then press Get Data again.";

const anyHoldsRows = async (datasets: string[]) => {
  for (const dataset of datasets) {
    const first: any = await getItemByIndex(dataset, 0).catch(() => undefined);
    if (first?.success) return true;
  }
  return false;
};

const snapshotDatasets = async (): Promise<string[]> => {
  const list = await getListOfDataContexts();
  const contexts: any[] = list.success ? list.values : [];
  return contexts.map(context => context.name).filter((name: string) => name.startsWith(kDatasetPrefix));
};

const datasetItems = async (dataset: string): Promise<any[]> => {
  const items = await getAllItems(dataset);
  return items.success ? items.values : [];
};

export const findImportedSnapshotIds = async () => {
  const ids = new Set<string>();
  const names = await snapshotDatasets().catch(() => [] as string[]);
  for (const name of names) {
    const first: any = await getItemByIndex(name, 0).catch(() => undefined);
    if (first?.success) ids.add(first.values.values[kObjectIdAttr]);
  }
  return ids;
};

export const selectSnapshotRows = async (objectId: string) => {
  for (const name of await snapshotDatasets()) {
    const items = isDatasetOf(name, objectId) ? await datasetItems(name) : [];
    const ids = items.filter(item => item.values[kObjectIdAttr] === objectId).map(item => item.id);
    await codapInterface.sendRequest({ action: "create", resource: `dataContext[${name}].selectionList`, values: ids });
  }
};

export const importSnapshot = async (
  storage: IObjectStorage, objectId: string, snapshotName: string, metadata: StoredObjectMetadata
) => {
  const index = await storage.readDataItem(objectId, kSnapshotIndexItemId);
  const tables = parseSnapshotTables(metadata, index);
  const read = await Promise.all(tables.map(async (table, tableIndex) => {
    const data = await storage.readDataItem(objectId, table.id);
    if (!data) throw new Error(`Table "${table.name}" could not be read.`);
    const rows: any[][] = data.rows ?? [];
    if (!Array.isArray(rows) || !rows.every(Array.isArray)) throw new Error(`Table "${table.name}" has invalid rows.`);
    return { table, tableIndex, rows };
  }));
  const withRows = read.filter(({ rows }) => rows.length > 0);
  if (withRows.length === 0) throw new Error("The snapshot has no rows.");

  const existing = new Set(await snapshotDatasets());
  const datasets = withRows.map(({ tableIndex }) => datasetName(objectId, tableIndex));
  for (const dataset of datasets.filter(name => existing.has(name))) {
    const first: any = await getItemByIndex(dataset, 0);
    if (first.success) throw new Error("It is already in CODAP.");
  }

  try {
    for (const { table, tableIndex, rows } of withRows) {
      const dataset = datasetName(objectId, tableIndex);
      const title = `${snapshotName}_${table.name}`;
      await createDataset(dataset, title, table);
      const items = rows.map(row => {
        const values: Record<string, unknown> = { [kObjectIdAttr]: objectId };
        table.cols.forEach((col, i) => { values[col] = row[i]; });
        return { values };
      });
      await requireSuccess(createItems(dataset, items), `the rows of "${title}"`);
      await requireSuccess(createTable(dataset), `a case table for "${title}"`);
    }
    await selectSnapshotRows(objectId);
  } catch (e) {
    for (const dataset of datasets) {
      if (existing.has(dataset)) await deleteSnapshotRows(dataset, objectId);
      else await deleteDataset(dataset);
    }
    if (await anyHoldsRows(datasets)) {
      const detail = e instanceof Error ? `${e.message} ` : "";
      throw new Error(`${detail}${kLeftoverRows}`);
    }
    throw e;
  }
};
