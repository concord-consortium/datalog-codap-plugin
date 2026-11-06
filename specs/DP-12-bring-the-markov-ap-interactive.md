# Bring multi-table snapshots into CODAP without breaking Agent Sim

**Jira**: https://concord-consortium.atlassian.net/browse/DP-12

**Status**: **Closed**

## Overview

The Datalog plugin learns a general saved format, the multi-value snapshot, that lets any interactive send several named, typed tables to CODAP. The Markov AP interactive is its first user. Agent Sim recordings keep their existing path and arrive exactly as they do today.

## Requirements

### The multi-value snapshot format

- **R1.** A snapshot is a `StoredObject` with `subType: "multi-value-snapshot"`. `type` stays `untyped`. Its display name is `description ?? name`, as for any saved object. Its object id is left to the library.
- **R2.** Each table is one `addDataTable({ id, name, cols, rows })` item. `name` is the table's own name, without the snapshot's. `rows` are arrays parallel to `cols`, with real JSON types. A short row leaves its remaining columns empty. Item `subType` is not read.
- **R3.** The snapshot has one index item: `addObject({ id: "tables", name: "Tables", data: { tables: [{ id, colTypes }] } })`, found by that fixed `id`. The order of `tables` is the table order. `colTypes` is parallel to the table's `cols`, each `"categorical"` or `"numeric"`. A data table the index does not name is ignored.
- **R4.** A snapshot is refused, with a message and nothing written to CODAP, when: the index is missing or malformed; `tables` is empty; an `id` is not a data table in the object; `colTypes` differs in length from `cols` or holds another value; the index names a table twice; `cols` repeats a name or holds an empty name; `cols` uses a reserved name, `__objectId`, `__id__` or `__proto__`; or a table's `rows` are not arrays of arrays.
- **R5.** The plugin holds no knowledge of any interactive that writes snapshots: no table name, column name or item id other than the index's.
- **R6.** The format is documented in `docs/multi-value-snapshot.md` for writers, with an example, and linked from the README.

### Bringing a snapshot into CODAP

- **R7.** A snapshot is listed like any saved object: one entry, by name, in saved order. Listing needs no extra reads.
- **R8.** Get Data reads the index and all its tables before writing anything to CODAP, so a failed read leaves CODAP untouched. A write that CODAP refuses or doesn't answer removes every dataset of that import and shows a message, so the snapshot stays not imported and pressing Get Data again starts clean. A selection CODAP answers with a refusal leaves the import in place, since its rows are all there. Only datasets that didn't exist before the attempt are removed. If a snapshot's dataset already holds rows, Get Data refuses with a message and writes nothing.
- **R9.** Each table with rows gets a new dataset of its own, keyed on the snapshot's object id and the table's position in the index, never on its shape. The dataset's title is `<snapshot display name>_<table name>`, such as "Data1_States". Its columns are in `cols` order, of the types in `colTypes`.
- **R10.** Each dataset has one flat collection, named with the table's `name`, holding the table's columns and a hidden `__objectId`. There is no parent collection and no column naming the snapshot.
- **R11.** A second snapshot always gets its own datasets, even with the same columns or the same name. Two snapshots with the same name get matching titles and stay separate. Rows from one snapshot never go into another's dataset.
- **R12.** A table with no rows is skipped, with no dataset created for it. A snapshot in which every table is empty is refused with a message, and nothing is written to CODAP.
- **R13.** After an import, each dataset that received rows has a case table open, in index order, and the snapshot's rows are selected in each.
- **R14.** A snapshot counts as imported when any snapshot dataset holds its `__objectId`, including after the plugin reloads in a saved document. Get Data is then disabled, as it is for recordings.
- **R15.** Clicking an imported snapshot selects its rows, matched by `__objectId`, and clears the selection in other snapshots' datasets.
- **R16.** A second press of Get Data during an import does nothing.

### Agent Sim and anything else

- **R17.** Any saved object without the snapshot `subType` takes today's path unchanged: dataset `DatalogPluginData`, its title, its two collections, all columns numeric, the first data table found, the same item values, matching by name for highlighting.
- **R18.** An object with the snapshot `subType` never writes to `DatalogPluginData`.

### Release

- **R19.** Released as 0.0.4, including the version the plugin reports to CODAP. The bump to 0.0.4 comes in its own release PR before the tag, as the repo usually does, not on the feature branch.
- **R20.** The version the plugin reports comes from `package.json`, so it is set in one place.

## Technical Notes

- `src/snapshot/multi-value-snapshot.ts` reads and validates the format, and `src/snapshot/import-snapshot.ts` builds the datasets. `src/components/App.tsx` keeps the Agent Sim path where it was and branches to these modules at the top of each entry point. The format is documented for writers in `docs/multi-value-snapshot.md`.
- Storage: `object-storage` writes each item as its own Firestore document holding a JSON string, so JSON types survive and the 1 MiB limit applies per table. The writer guards size. `addObject` and `readDataItem` work for the index with no library change.
- CODAP 3.1.2 behavior, verified with a throwaway plugin:
  - `create component` of type `caseTable` for a dataset that already has a table returns that table's id, so repeating it is safe.
  - Two datasets may share a title. Dataset names may contain spaces.
  - A flat collection with a hidden `__objectId` shows only the table's columns, and the hidden value is still returned with each item.
  - A `null` value arrives as empty. A selection sent as item ids selects those rows.
  - An attribute created `categorical` stays categorical when all its values look like numbers (`"1"`), and a `numeric` one stays numeric.
  - The table header shows a collection's `name`, not its `title`, so the collection takes the table's name. A name with a space works.
  - `create item` treats a top-level `id` on an item as the item's own id. A column named `id` sent that way loses rows: with repeated values, a later row overwrites an earlier one and the item ids come back `null`. Sent as `{ values: { ... } }`, the same column arrives intact, so snapshot rows always use that shape.
  - `delete dataContext[<name>]` removes the dataset and its open case table.
  - Values lose leading and trailing whitespace, and inner spaces stay: `" - "` comes back as `"-"`, `"  a  b  "` as `"a  b"`, and `" "` as `""`. Column names with spaces work.
  - `get dataContext[<name>].item[0]` returns the first remaining item. With no rows left it answers `success: false`.
- Dataset identity must be recoverable after reload, so the dataset name is built from the object id and the table's index position, with a fixed prefix that identifies snapshot datasets in `dataContextList`. A table's name or id cannot go in the name directly: resources are written `dataContext[<name>]`, so writer text is free text in the wrong place.
- CODAP's `create dataContext` returns the existing dataset for a repeated name, so a key that repeated across sends would silently merge them, and a retry after a partial import would add its rows a second time. This is why R8 removes the datasets.
- `codapInterface.sendRequest` rejects after 2 seconds with no reply, with a plain string holding the whole request (878 KB at 12,500 rows), not an `Error`, while CODAP goes on to finish the work. With the plugin on a different site from CODAP and the CPU throttled 6 times, a 12,500-row `create item` hit this: its rows landed, the next table was never started, and the plugin reported failure. With the plugin on a `concord.org` host, as deployed, plugin and CODAP share a thread, and requests of up to 12 seconds succeeded, so this should be rare in production, but local development on `localhost` can show it.
- Selection is the slow part of a large import. Two tables of 12,500 rows, on a `concord.org` host, took 11 seconds, 3.7 to 5.5 of them for each `selectionList`, and 38 seconds with the CPU throttled 6 times. Clicking an imported snapshot repeats the selection. That size is near the top of what MARK-18 can send; ordinary texts are far smaller.
- CODAP places a new case table in the first empty spot in the visible document. When none is left, it centers the table, so later tables land exactly on top of each other. Measured on 3.1.2 with 16 tables: at 868 by 651, the Activity Player's inline size, the first 4 found room and the other 12 piled at one spot; at 1440 by 900, 9 found room and the other 7 piled.
- `playwright.yml` is disabled and the existing Playwright test asserts nothing. Automated coverage is Jest; the CODAP checks are manual on a branch deploy.
- The plugin only runs fully under the Activity Player, so the real end-to-end check needs an activity with both interactives.

### Corrections to the Jira details

Each detail was checked against the code and against CODAP 3.1.2 (codap3.concord.org) with a throwaway plugin.

| Jira says | Finding |
|---|---|
| A second table lands in a dataset without its columns | Confirmed. CODAP answers `success: true` and silently drops values for attributes that do not exist. |
| Every column is created as numeric | True of the table's columns; `name` and `__objectId` are categorical. The effect is milder than "words are lost": a numeric attribute keeps and shows the string `the`. The wrong type is what hurts analysis. |
| Set each column's type from metadata, or infer it | Neither as worded. `addDataTable` drops unknown options, so table metadata has no slot for types without a library release, and an empty column cannot be inferred. Types travel in the snapshot's index (below). |
| Only the first data table is read | Confirmed, and "first" is arbitrary: `metadata.items` is a Firestore map, so its order is not a contract. |
| Give each table shape its own dataset | Replaced by Rebecca's decision: every table of every send gets its own dataset. Applies to snapshots only. Agent Sim must stay as it is, so its recordings keep joining one dataset, and one with new columns keeps losing them. |
| One table per kind | One table per kind for each send, so a student's second send adds a second States table. |

Two defects the Jira does not mention bear on this work:

- The plugin listens on `dataContext[DatalogPluginData].case`, a resource CODAP never sends. Change notices arrive on `dataContextChangeNotice[<name>]`; in the probe only that one fired. So the imported state is computed at load and after the plugin's own import, and never reacts to a student deleting rows.
- `highlightDataSet` matches rows by display name, which cannot tell apart two snapshots with the same name.

### What Agent Sim saves

Checked in `question-interactives` at version 1.28.0, `packages/agent-simulation/src/components/agent-simulation.tsx`, which uses object-storage 1.0.0-pre.9, the same version as this plugin.

- Object: `type: "simulation-recording"`, `subType: "agent-simulation"`, `name: "Simulation Recording"`, `description` of `<model>: <time> (<duration>)`, or the model name alone.
- Items, with generated ids: up to two images (`simulation-screenshot`, `simulation-thumbnail`), one data table (`simulation-tick-data`), one text (`simulation-code`).
- The table's `cols` are the keys of the first tick, falling back to the sim's globals; `rows` are arrays of values. With no ticks, `rows` is empty.
- Recordings saved before that format existed have no `type` or `subType` set beyond the default `untyped`, with the same single data table. This is why the new path keys on the snapshot's marker and not on the absence of Agent Sim's.

## Out of Scope

- Changing what Agent Sim saves or how its recordings import, including the dropped-columns limit.
- The existing bug where the row listener in `App.tsx` subscribes to a resource CODAP never sends. Snapshots share its effects until it is fixed separately.
- A library release of `object-storage`. Column types beyond categorical and numeric.
- Which tables, columns and row meanings Markov sends, and size guarding: MARK-18.
- Placing case tables. CODAP's own placement applies, so once a document is full, later tables pile on top of each other until a student moves them.
- Putting two sends in one table or on one graph. A CODAP graph takes one dataset, so sends compare side by side.

## Not Yet Implemented

The steps below finish the release.

- End-to-end check: a branch deploy (DP-12's own before merge, or `branch/main/` after it) on a copy of staging activity 1458 with the Markov interactive in place of Agent Sim, using a snapshot from MARK-18's branch build, and on staging activity 1458, the real Agent Sim activity. This is the first run of the real `App.tsx` load path, Firestore and the Activity Player. The import modules were run in CODAP 3.1.2 with demo storage.
- Bump the version to 0.0.4 in `package.json` and `package-lock.json`, in its own release PR, once the check passes.
- Tag that PR's merge commit on `main` as `v0.0.4` and push the tag. `ci.yml` deploys it under `version/v0.0.4/`.
- Run the Release workflow (`release.yml`) with version `v0.0.4`, which copies that version's `index-top.html` to the top-level `index.html`. Promotion changes the plugin for every activity using the top-level URL at once. To roll back, run the Release workflow with `v0.0.3`.
- This is the first tag and release run since deployment moved to OIDC, so a failure in the tag or release step is most likely the role's trust policy, not this code.

Timeouts on `sendRequest`, which should be rare on a `concord.org` host, are accepted in three places: a read that times out at load shows that snapshot as not imported, though Get Data then refuses rather than repeating its rows; a selection timeout on any snapshot's dataset rolls back the new import; and a timeout when clicking a snapshot is an unhandled rejection, as it is for recordings.

## Decisions

### How do types and table order travel in the snapshot?
**Options considered**:
- A) An index item through `addObject`.
- B) Extra fields set on `metadata.items[id]` after `addDataTable`.
- C) Inference from JSON values, with order from item ids.
- D) New `object-storage` options.

**Decision**: A, confirmed by Doug. It uses only the public API, and everything is explicit, as Doug asked. B needs casts on both sides. C cannot type an empty column. D is the cleanest long term but adds a library release to a 3-point story.

### Why key on the snapshot marker and not on Agent Sim's?
**Options considered**:
- A) New path only for `multi-value-snapshot`.
- B) Old path only for `simulation-recording`.

**Decision**: A. Early recordings are `untyped`, so B would send them down the new path.

### Does a second send join the first's tables, or get its own?
**Decision**: Its own. Rebecca chose a new set of tables per send, named like her files, and Doug confirmed it. Students compare sends side by side; two sends cannot share a graph. Agent Sim keeps joining.

### Who builds a table's title?
**Decision**: The plugin, as `<snapshot display name>_<table name>`, agreed with MARK-18. Writers send each table's own word as `name`, so telling two sends apart holds for every interactive and the send's name is stored once. MARK-18 sends "Input", "States", "Transitions" and "Outputs", the same words in both modes (Draw mode has no Input table), which matches its download names.

### Is a column needed to name the snapshot?
**Decision**: No. The table's title says which send it is, so the `snapshot` column and its parent level are gone. The hidden `__objectId` stays, because imported tracking and selection use it.

### How is the end-to-end check run, given that MARK-18 needs this release?
**Context**: The done condition needs a real Markov snapshot, and promotion affects every live activity.

**Decision**: Check a branch deploy on a staging activity, with MARK-18's branch build writing the snapshot: DP-12's own deploy before merge, or `branch/main/` after it, whichever exists when MARK-18's build is ready. No version is needed for the check. Doug and the implementer set up the activity together in Playwright when the build is ready, as a copy of activity 1458 with the Markov interactive in place of Agent Sim. Tag `v0.0.4` and promote only after it passes, so a failed check costs a fix, not a second tag.

### Which real Agent Sim activity is the done check run against?
**Context**: The story's done condition needs a real activity with saved recordings, and no document in the stream named one.

**Decision**: Staging activity 1458, "Blockly + Agent Sim + CODAP Datalog with Data Source Interactive". Doug chose it after a recording saved there reached the plugin and imported. Its plugin URL must be pointed at the same branch deploy for the check.

### Leave the Agent Sim code in `App.tsx`, or extract it?
**Options considered**:
- A) Leave it, and branch to new modules.
- B) Extract both paths behind one interface.

**Decision**: A. Moving the old path adds risk to the one thing that must not change, and a smaller diff is easier to review against the pinned test.

### How is the dataset name built?
**Options considered**:
- A) Fixed prefix, the object id, and the table's position in the index.
- B) Fixed prefix and a hash of the object id and table id.

**Decision**: A. Object ids are library nanoids, which are safe in a `dataContext[...]` resource, and a position is a number, so no writer text reaches the name. It needs no hash, and it cannot collide.

### Review decisions

Each of these is reflected in the code, and was run in CODAP 3.1.2 where the Technical Notes say so.

- A collection named, not titled, after the table is what the case table's header shows (R10).
- The index's `subType` was never read, so it left the format.
- A snapshot with every table empty is refused (R12).
- Rows go as `{ values }`, because a column named `id` sent at the top level loses rows.
- R4 refuses `__id__`, an empty column name, a table named twice, and a non-string index id. On CODAP 3.1.2 the first collapses rows and the second is dropped with `success: true`.
- A failed write removes the import's datasets, so a retry starts clean (R8). `createDataset`, `createItems` and `createTable` are all checked, and the selection sits inside the same cleanup: one that gets no answer rolls the import back, because a retry would otherwise repeat every row. One CODAP answers with a refusal keeps the import, since only the highlight is lost.
- CODAP's failed replies carry `values: { error }`, so reads test `success` before using `values`. A rejected read during the load scan counts as no items.
- Before writing, an import checks its dataset names. One that holds rows refuses the import, so a retry after a failed delete, or after a read that timed out at load, can't repeat rows. An existing empty dataset is filled and kept if the import fails, and rollback removes only what the attempt created. A failed delete can leave a partial import in place, which stays until a student removes it.
- Selecting a snapshot reads only its own datasets, found from the dataset name, and sends the others an empty selection.
- `__proto__` is a reserved column name, because assigning it to a plain object loses the value.
- The load scan reads one item from each snapshot dataset, not every row, since all of a dataset's rows share one `__objectId`. A dataset with every row deleted counts as not imported.
- The list and Get Data appear only once the imported state is known, so a press during the load scan can't repeat a snapshot's rows. They still appear if that scan fails, and a failed read of snapshot datasets or of `DatalogPluginData` doesn't lose the other's imported ids.
- `kVersion` is a default import of `package.json`, because webpack warns on a named import from JSON. The bundle takes in only the version.
