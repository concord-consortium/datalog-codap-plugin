# Implementation Plan: Bring multi-table snapshots into CODAP without breaking Agent Sim

**Jira**: https://concord-consortium.atlassian.net/browse/DP-12
**Requirements Spec**: [requirements.md](requirements.md)
**Status**: **In Development**

## Implementation Plan

No dependency or lockfile changes are needed, apart from the version bump in the release step. `App.tsx` keeps today's import code where it is, so the Agent Sim path is not moved or rewritten; a branch at the top of each entry point sends snapshots to new modules. The module code below was built and run against real object-storage and CODAP 3.1.2 before being written here.

### Pin Agent Sim's import with a test

**Summary**: A test-only commit on the unchanged `App.tsx`, so every later commit is measured against today's behavior.

**Files affected**:
- `src/components/App.agent-sim.test.tsx`: new

**Estimated diff size**: ~110 lines

Mocks `@concord-consortium/codap-plugin-api`, and `createObjectStorage` to return a stub with `monitor` and `readDataItem`. The mock includes `getListOfDataContexts`, resolving to `{ success: true, values: [] }`, even though the unchanged `App` doesn't call it, so this file needs no editing when `checkAllCases` starts to. This harness was run against the unchanged `App`. The stored object uses the exact shape in the requirements' "What Agent Sim saves", with two images, a text item, and a table whose values differ per row and per column. Tests:

- The `dataContext` create request equals the full literal payload (name, title, both collections, every column `numeric`, hidden `__objectId`). Catches any change to type, title or collection.
- `createItems` receives the literal items, in row order. Catches a column shift or a changed `name`.
- `createTable` is called with `DatalogPluginData`, and no other dataset is touched. Catches a recording sent to a snapshot dataset.
- An `untyped` object with one data table takes the same path. Catches keying on Agent Sim's `type`.
- An object with two data tables imports only the first. Catches the old path starting to read every table.

---

### Read the snapshot format

**Summary**: The format's constants, types and validation, with no CODAP or storage calls.

**Files affected**:
- `src/snapshot/multi-value-snapshot.ts`: new
- `src/snapshot/multi-value-snapshot.test.ts`: new

**Estimated diff size**: ~150 lines

```ts
import { StoredObjectDataTableMetadata, StoredObjectMetadata } from "@concord-consortium/object-storage";

export const kSnapshotSubType = "multi-value-snapshot";
export const kSnapshotIndexItemId = "tables";
export const kObjectIdAttr = "__objectId";
const kReservedCols = [kObjectIdAttr, "__id__"];

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
  const item = metadata.items[entry?.id];
  if (typeof entry?.id !== "string" || item?.type !== "dataTable") {
    throw new Error(`The index names "${entry?.id}", which is not a data table.`);
  }
  const { name, cols } = item as StoredObjectDataTableMetadata;
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
```

Tests use a real `StoredObject` written through the demo storage, then one case per R4 refusal, asserting the message, so deleting any one check fails its case. The order test uses an index whose order differs from `metadata.items`, which catches reading `metadata.items` in place of the index. A data table the index doesn't name is left out of the result, which catches the same thing from the other side (R3).

---

### Import a snapshot into CODAP

**Summary**: Dataset naming, creation, row loading, selection, and finding what is imported. Nothing calls it yet.

**Files affected**:
- `src/snapshot/import-snapshot.ts`: new
- `src/snapshot/import-snapshot.test.ts`: new

**Estimated diff size**: ~515 lines, about 420 of them tests

```ts
import {
  codapInterface, createItems, createTable, getAllItems, getListOfDataContexts
} from "@concord-consortium/codap-plugin-api";
import { IObjectStorage, StoredObjectMetadata } from "@concord-consortium/object-storage";
import { kObjectIdAttr, kSnapshotIndexItemId, parseSnapshotTables, SnapshotTable } from "./multi-value-snapshot";

const kDatasetPrefix = "DatalogSnapshotTable_";

export const datasetName = (objectId: string, tableIndex: number) => `${kDatasetPrefix}${objectId}_${tableIndex}`;

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
    const items = await datasetItems(name).catch(() => []);
    items.forEach(item => ids.add(item.values[kObjectIdAttr]));
  }
  return ids;
};

export const selectSnapshotRows = async (objectId: string) => {
  for (const name of await snapshotDatasets()) {
    const items = await datasetItems(name);
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
    return { table, tableIndex, rows: (data.rows ?? []) as any[][] };
  }));
  const withRows = read.filter(({ rows }) => rows.length > 0);
  if (withRows.length === 0) throw new Error("The snapshot has no rows.");

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
    for (const { tableIndex } of withRows) await deleteDataset(datasetName(objectId, tableIndex));
    throw e;
  }
};
```

A selection that gets no answer rolls the import back like any other write, but one CODAP answers with a refusal does not: the rows are all there, so only the highlight is lost.

Tests mock the CODAP API with an in-memory list of datasets, which, like CODAP, returns the existing dataset for a repeated name:

- `datasetName` differs by object id and by table position. Catches dropping either from the key.
- Two snapshots with identical tables make separate datasets, with no rows mixed. Catches a key that ignores the object id.
- Two snapshots with the same name stay separate, with matching titles. Catches a key built from the name.
- Titles are `<snapshot name>_<table name>`, with two snapshots so a fixed title fails.
- The create request has one collection, with types and column order intact and `__objectId` hidden, using two columns of different types so a swap fails.
- Items are `{ values }`, with `__objectId` and each column, and a short row leaves its last column undefined. Catches sending bare items, which lose rows with an `id` column, and a column shift.
- A failing read of the last table leaves no CODAP request sent. Catches writing as each table is read.
- An empty table is skipped without shifting the next table's dataset name; an all-empty snapshot throws. Catches numbering after the filter.
- `createTable` calls follow index order, using an index whose order differs from `metadata.items`. Catches a loop over the items.
- `createDataset` answering `success: false`, and `createItems` answering it on the second table, each reject, naming the title. Catches dropping `requireSuccess`.
- A `createItems` that rejects on the second table sends a delete for each table's dataset, rethrows the same value, and a second `importSnapshot` then leaves each table with its rows once. Catches dropping the `catch`, which repeats the first table's rows.
- A refused or rejected write at each later stage (`createDataset` refused on the second table, `createTable` refused or rejecting, the selection rejecting) removes every dataset, and a second import after a rejected selection gives each table its rows once. Catches moving any of them out of the `try`, or not checking `createTable` (R8).
- A delete that rejects during that cleanup still rethrows the first failure, and the next dataset is still deleted. Catches dropping the `.catch` in `deleteDataset`, or moving it around the loop.
- After an import, the snapshot's own datasets receive its item ids as a selection. Catches dropping the selection from `importSnapshot` (R13).
- `findImportedSnapshotIds` returns ids from every prefixed dataset and ignores `DatalogPluginData` and unrelated datasets. Catches dropping the prefix filter.
- A failed `getAllItems` or `getListOfDataContexts` reply, whose `values` holds an error, is treated as no items or no datasets. Catches a dataset deleted mid-read stopping `init`. `findImportedSnapshotIds` treats a rejected read the same way.
- A selection CODAP refuses keeps the import. Catches treating a lost highlight as a failed import.
- `selectSnapshotRows` sends a snapshot's item ids to its own datasets and an empty selection to another snapshot's. Catches skipping datasets with no match, which would leave the old selection (R15).

---

### Bring snapshots in from the plugin

**Summary**: Connect the modules to the component. Apart from the version import in the release step, this is the only change to `App.tsx`.

**Files affected**:
- `src/components/App.tsx`
- `src/components/App.snapshot.test.tsx`: new
- `src/test/app-harness.ts`: new, the CODAP and storage stubs both App tests share

**Estimated diff size**: ~180 lines

- Add `metadata: StoredObjectMetadata` to `StoredObjectDataTable`, set in the `monitor` callback. Listing logic stays as it is, since a snapshot has a data table and no image.
- Add `const importingRef = useRef(false);` beside the other refs.
- `checkAllCases`: start from `await findImportedSnapshotIds()`, add recording ids when `getAllItems` succeeds, and always set the state, even if that read rejects. Today's `if` around the state update moves inward so that a document with snapshots and no `DatalogPluginData` still works. With no snapshots the result is the same.
- `init`: `setObjectStorageConfig` moves after `await checkAllCases()`, which logs a rejection, so the list and Get Data appear only once the imported state is known (R14), and still appear if that read rejects. Otherwise a press during the scan repeats an imported snapshot's rows.
- `highlightDataSet`: when `highlightObject && isSnapshot(highlightObject.metadata)`, call `selectSnapshotRows(id)` and return.
- `handleGetData`: after finding the selected object, when it is a snapshot, run this and return:

```ts
const { metadata, name } = selectedDataTableObject;
if (isSnapshot(metadata)) {
  const storage = objectStorageRef.current;
  if (!storage || importingRef.current) return;
  importingRef.current = true;
  try {
    await importSnapshot(storage, selectedDataTableObjectId, name, metadata);
    setImportedDataTableIds(prev => new Set(prev).add(selectedDataTableObjectId));
  } catch (e) {
    console.error("Failed to import snapshot:", e);
    const detail = e instanceof Error ? ` ${e.message}` : "";
    alert(`This saved data could not be brought into CODAP.${detail}`);
  } finally {
    importingRef.current = false;
  }
  return;
}
```

The `instanceof` is there because a CODAP timeout rejects with a string holding the whole request, which is no message for a student.

Tests, through the same harness as the Agent Sim test, whose assertions stay green and unedited:

- A snapshot's Get Data creates no `DatalogPluginData` request (R18). Catches the branch sitting after the old path's first write.
- Two quick presses import once (R16). Catches dropping `importingRef`.
- A malformed index alerts and sends nothing. Catches a refusal that isn't caught.
- A `createItems` rejecting with a string alerts exactly the plain sentence, and Get Data stays enabled. Catches `(e as Error).message`, which shows "undefined", and marking a failed import as imported.
- A snapshot found at load shows as imported, with `DatalogPluginData` absent. Catches leaving the state update inside the `if`.
- No list shows while the load scan runs, and the list still shows when it rejects. Catches the list appearing before the imported state is known, or never.
- A snapshot dataset that can't be read at load leaves a recording's imported state intact. Catches a rejected snapshot read stopping `checkAllCases` (R17).
- Listing a snapshot calls no `readDataItem` (R7). Catches reading the index to list.
- Clicking an imported snapshot selects by id; clicking a recording still selects by name. Catches the branch applying to both.

---

### Document the format

**Summary**: Writers need one place to read the contract.

**Files affected**:
- `docs/multi-value-snapshot.md`: new
- `README.md`: one line, and "CODAP plugin to load linked AP object storage data." stays true

**Estimated diff size**: ~90 lines

Covers R1 to R4 and R9 to R12 for a writer: the object, tables, the index, a complete example with neutral table names, the reserved columns `__objectId` and `__id__` and index id `tables`, what makes a snapshot refused, how each table of each send becomes its own dataset, how the title is built from the snapshot's name and the table's name, the 1 MiB limit per table, and that the object-storage version in use must have `addObject`.

---

### Release 0.0.4

**Summary**: The repo's convention is a separate version PR after the feature merges. Here the two version commits sit at the end of the DP-12 branch, so they can ship with the feature or move to their own PR. `kVersion` becomes `packageJson.version`, with `import packageJson from "../../package.json"`, so the version lives in one place (R20). It is a default import because webpack warns on a named import from JSON. Checked: `tsc` passes, the production build has no warning, and the bundle takes in only the version, not the rest of `package.json`. `App.agent-sim.test.tsx` gains one assertion, that `initializePlugin` receives `package.json`'s version. Catches a hardcoded version coming back.

**Files affected**:
- `package.json`, `package-lock.json`: version only, in a commit of their own
- `src/components/App.tsx`, `src/components/App.agent-sim.test.tsx`: the import and its test, in a separate commit before the bump

**Estimated diff size**: ~8 lines

Release steps, with the tag and promotion after that PR merges:

1. Check a branch deploy (DP-12's own before merge, or `branch/main/` after it) on a copy of staging activity 1458 with the Markov interactive in place of Agent Sim, using a snapshot from MARK-18's branch build, and on staging activity 1458, the real Agent Sim activity.
2. Tag the merge commit on `main` as `v0.0.4` and push the tag. `ci.yml` runs on every push and deploys the tag under `version/v0.0.4/`.
3. Run the Release workflow (`release.yml`) with version `v0.0.4`. It copies that version's `index-top.html` to the top-level `index.html`.

Promotion changes the plugin for every activity using the top-level URL at once. To roll back, run the Release workflow with `v0.0.3`.

This is the first tag and the first release run since deployment moved to OIDC, so a failure in step 2 or 3 is most likely the role's trust policy, not this code.

## Open Questions

### RESOLVED: Judgment call: leave the Agent Sim code in `App.tsx`, or extract it?
**Options considered**:
- A) Leave it, and branch to new modules.
- B) Extract both paths behind one interface.

**Decision**: A. Moving the old path adds risk to the one thing that must not change, and a smaller diff is easier to review against the pinned test.

### RESOLVED: Judgment call: how is the dataset name built?
**Options considered**:
- A) Fixed prefix, the object id, and the table's position in the index.
- B) Fixed prefix and a hash of the object id and table id.

**Decision**: A. Object ids are library nanoids, which are safe in a `dataContext[...]` resource, and a position is a number, so no writer text reaches the name. It needs no hash, and it cannot collide.

## Self-Review

Reviewed as commit reviewer, test writer, operator, and senior engineer.

- **Commit reviewer:** each step compiles and passes alone, because the modules land before anything calls them and the Agent Sim test lands first. Checked by building the proposed modules against the unchanged `App`.
- **Test writer:** the App harness was run for real against the unchanged component. The demo storage round trip was run with `addDataTable`, `addObject` and `readDataItem`.
- **Operator:** the first-release-since-OIDC risk and the all-at-once promotion are now in the release step, with the rollback.
- **Senior engineer:** `createItems`, `createDataset` and `createTable` throw on a refused write, so it can't look like success. That check was prose beside the code, and now sits in the code.
- **Senior engineer:** a failed write left a partial import that a second press duplicated. `importSnapshot` now deletes the import's datasets. Run on CODAP 3.1.2 through a real timeout: no dataset or table remained, and a re-press gave each table its rows once.
- **Commit reviewer:** the `handleGetData` snippet failed `tsc` (`importingRef` undeclared, `id` and `metadata` not in scope, a nullable storage ref), and `highlightObject` could be undefined. The snippet and bullets are corrected, compiled with the modules, and run through a throwaway `App` test.
- **Commit reviewer:** the named JSON import added a webpack warning, so it is now a default import. A stale step number in the OIDC note is corrected.
- **Test writer:** the pinned harness needed a stub the unchanged `App` doesn't use, or its later commits break it. Each test now names what it catches, and R7, R13 and the version got tests.
