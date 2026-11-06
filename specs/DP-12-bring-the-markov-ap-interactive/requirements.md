# Bring multi-table snapshots into CODAP without breaking Agent Sim

**Jira**: https://concord-consortium.atlassian.net/browse/DP-12
**Repo**: https://github.com/concord-consortium/datalog-codap-plugin
**Implementation Spec**: [implementation.md](implementation.md)
**Status**: **In Development**

## Overview

The Datalog plugin learns a general saved format, the multi-value snapshot, that lets any interactive send several named, typed tables to CODAP. The Markov AP interactive is its first user. Agent Sim recordings keep their existing path and arrive exactly as they do today.

## Project Owner Overview

Students using the Markov AP interactive press Send to CODAP (MARK-18) and then bring their tables into CODAP through the Datalog plugin on the same page. Today the plugin only understands one all-numbers table per saved object, because it was built for Agent Sim. This story makes it read several tables, keep words as words, and give every send its own set of tables, named like the student's downloaded files, so two sends can be compared side by side.

The format is deliberately not Markov-specific: table names, columns, column types and table order all come from the snapshot, so a later interactive can use it with no plugin change. Agent Sim is used in real activities, so it is protected by keeping it on its own unchanged path, not by making the new code compatible with it. Released as 0.0.4, which MARK-18 needs.

## Background

The plugin runs in a CODAP interactive inside the Activity Player. It watches the object storage of the interactive linked as `data_source_interactive`, lists each saved object that has a data table, and on Get Data copies a table into CODAP. All of this is in `src/components/App.tsx`.

The source decisions are question 5, follow-ups C and E, and "Where we landed", Send to CODAP (updated), in the Markov Tech Specs doc: four separate tables (input data, states, transitions, outputs), each press saves a new named snapshot, and saving twice lets students compare two texts in CODAP. Doug then set the direction that the format is generic, with Markov as its first user. Rebecca then chose a new set of tables for every send, named like her files ("Data1_States", "Data2_States", "Drawing1_States"), over adding later sends to the same tables.

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

## Requirements

### The multi-value snapshot format

- **R1.** A snapshot is a `StoredObject` with `subType: "multi-value-snapshot"`. `type` stays `untyped`. Its display name is `description ?? name`, as for any saved object. Its object id is left to the library.
- **R2.** Each table is one `addDataTable({ id, name, cols, rows })` item. `name` is the table's own name, without the snapshot's. `rows` are arrays parallel to `cols`, with real JSON types. A short row leaves its remaining columns empty. Item `subType` is not read.
- **R3.** The snapshot has one index item: `addObject({ id: "tables", name: "Tables", data: { tables: [{ id, colTypes }] } })`, found by that fixed `id`. The order of `tables` is the table order. `colTypes` is parallel to the table's `cols`, each `"categorical"` or `"numeric"`. A data table the index does not name is ignored.
- **R4.** A snapshot is refused, with a message and nothing written to CODAP, when: the index is missing or malformed; `tables` is empty; an `id` is not a data table in the object; `colTypes` differs in length from `cols` or holds another value; the index names a table twice; `cols` repeats a name or holds an empty name; or `cols` uses a reserved name, `__objectId` or `__id__`.
- **R5.** The plugin holds no knowledge of any interactive that writes snapshots: no table name, column name or item id other than the index's.
- **R6.** The format is documented in `docs/multi-value-snapshot.md` for writers, with an example, and linked from the README.

### Bringing a snapshot into CODAP

- **R7.** A snapshot is listed like any saved object: one entry, by name, in saved order. Listing needs no extra reads.
- **R8.** Get Data reads the index and all its tables before writing anything to CODAP, so a failed read leaves CODAP untouched. A write that CODAP refuses or doesn't answer removes every dataset of that import and shows a message, so the snapshot stays not imported and pressing Get Data again starts clean. A selection CODAP answers with a refusal leaves the import in place, since its rows are all there.
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

- **R19.** Released as 0.0.4, including the version the plugin reports to CODAP.
- **R20.** The version the plugin reports comes from `package.json`, so it is set in one place.

## Technical Notes

- `src/components/App.tsx` holds everything today. Format reading and dataset building should sit in testable modules outside the component; only `App.test.tsx`'s render smoke test exists now.
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
- Dataset identity must be recoverable after reload, so the dataset name is built from the object id and the table's index position, with a fixed prefix that identifies snapshot datasets in `dataContextList`. A table's name or id cannot go in the name directly: resources are written `dataContext[<name>]`, so writer text is free text in the wrong place.
- CODAP's `create dataContext` returns the existing dataset for a repeated name, so a key that repeated across sends would silently merge them, and a retry after a partial import would add its rows a second time. This is why R8 removes the datasets.
- `codapInterface.sendRequest` rejects after 2 seconds with no reply, with a plain string holding the whole request (878 KB at 12,500 rows), not an `Error`, while CODAP goes on to finish the work. With the plugin on a different site from CODAP and the CPU throttled 6 times, a 12,500-row `create item` hit this: its rows landed, the next table was never started, and the plugin reported failure. With the plugin on a `concord.org` host, as deployed, plugin and CODAP share a thread, and requests of up to 12 seconds succeeded, so this should be rare in production, but local development on `localhost` can show it.
- Selection is the slow part of a large import. Two tables of 12,500 rows, on a `concord.org` host, took 11 seconds, 3.7 to 5.5 of them for each `selectionList`, and 38 seconds with the CPU throttled 6 times. Clicking an imported snapshot repeats the selection. That size is near the top of what MARK-18 can send; ordinary texts are far smaller.
- CODAP places a new case table in the first empty spot in the visible document. When none is left, it centers the table, so later tables land exactly on top of each other. Measured on 3.1.2 with 16 tables: at 868 by 651, the Activity Player's inline size, the first 4 found room and the other 12 piled at one spot; at 1440 by 900, 9 found room and the other 7 piled.
- `playwright.yml` is disabled and the existing Playwright test asserts nothing. Automated coverage is Jest; the CODAP checks are manual on a branch deploy.
- The plugin only runs fully under the Activity Player, so the real end-to-end check needs an activity with both interactives.

## Out of Scope

- Changing what Agent Sim saves or how its recordings import, including the dropped-columns limit.
- The existing bug where the row listener in `App.tsx` subscribes to a resource CODAP never sends. Snapshots share its effects until it is fixed separately.
- A library release of `object-storage`. Column types beyond categorical and numeric.
- Which tables, columns and row meanings Markov sends, and size guarding: MARK-18.
- Placing case tables. CODAP's own placement applies, so once a document is full, later tables pile on top of each other until a student moves them.
- Putting two sends in one table or on one graph. A CODAP graph takes one dataset, so sends compare side by side.

## Open Questions

### RESOLVED: Judgment call: how do types and table order travel in the snapshot?
**Options considered**:
- A) An index item through `addObject`.
- B) Extra fields set on `metadata.items[id]` after `addDataTable`.
- C) Inference from JSON values, with order from item ids.
- D) New `object-storage` options.

**Decision**: A, confirmed by Doug. It uses only the public API, and everything is explicit, as Doug asked. B needs casts on both sides. C cannot type an empty column. D is the cleanest long term but adds a library release to a 3-point story.

### RESOLVED: Judgment call: why key on the snapshot marker and not on Agent Sim's?
**Options considered**:
- A) New path only for `multi-value-snapshot`.
- B) Old path only for `simulation-recording`.

**Decision**: A. Early recordings are `untyped`, so B would send them down the new path.

### RESOLVED: Does a second send join the first's tables, or get its own?
**Decision**: Its own. Rebecca chose a new set of tables per send, named like her files, and Doug confirmed it. Students compare sends side by side; two sends cannot share a graph. Agent Sim keeps joining.

### RESOLVED: Who builds a table's title?
**Decision**: The plugin, as `<snapshot display name>_<table name>`, agreed with MARK-18. Writers send each table's own word as `name`, so telling two sends apart holds for every interactive and the send's name is stored once. MARK-18 sends "Input", "States", "Transitions" and "Outputs", the same words in both modes (Draw mode has no Input table), which matches its download names.

### RESOLVED: Is a column needed to name the snapshot?
**Decision**: No. The table's title says which send it is, so the `snapshot` column and its parent level are gone. The hidden `__objectId` stays, because imported tracking and selection use it.

### RESOLVED: How is the end-to-end check run, given that MARK-18 needs this release?
**Context**: The done condition needs a real Markov snapshot, and promotion affects every live activity.

**Decision**: Check a branch deploy on a staging activity, with MARK-18's branch build writing the snapshot: DP-12's own deploy before merge, or `branch/main/` after it, whichever exists when MARK-18's build is ready. No version is needed for the check. Doug and the implementer set up the activity together in Playwright when the build is ready, as a copy of activity 1458 with the Markov interactive in place of Agent Sim. Tag `v0.0.4` and promote only after it passes, so a failed check costs a fix, not a second tag.

### RESOLVED: Which real Agent Sim activity is the done check run against?
**Context**: The story's done condition needs a real activity with saved recordings, and no document in the stream named one.

**Decision**: Staging activity 1458, "Blockly + Agent Sim + CODAP Datalog with Data Source Interactive". Doug chose it after a recording saved there reached the plugin and imported. Its plugin URL must be pointed at the same branch deploy for the check.

## Self-Review

Reviewed as senior engineer, QA engineer, student, and operator. Each finding was checked by running the proposed import against CODAP 3.1.2 and the real storage library, and fixed in place.

- **Student:** a collection titled, not named, after the table still showed "rows" in the header. R10 now names it.
- **Senior engineer:** the index's `subType` was never read, so it was removed from the format.
- **QA engineer:** R12 did not say what happens when every table is empty. It now refuses.
- **Senior engineer:** a partial import could not be retried, since a second press repeated the first table's rows and a reload then showed the snapshot as imported with tables missing. R8 now removes the import's datasets. Reproduced on CODAP 3.1.2, with the fix run through a real timeout.
- **Senior engineer:** a column named `id` lost rows, because CODAP reads it as the item's id. Rows now go as `{ values }` (Technical Notes). Reproduced on CODAP 3.1.2.
- **QA engineer:** "in both modes" overstated MARK-18's tables, since Draw mode has no Input. Corrected.
- **Senior engineer:** R4 let three writer mistakes through, run on 3.1.2: a column named `__id__` collapses rows, a column named `""` is dropped with `success: true`, and an index naming a table twice would make two identical datasets. R4 now refuses all three.
