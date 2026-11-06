# Multi-value snapshot format

A multi-value snapshot is how an interactive sends several named, typed tables to CODAP through the Datalog plugin. The format holds no knowledge of any one interactive: table names, column names, column types and table order all come from the snapshot.

An interactive writes a snapshot to object storage. The plugin lists the snapshots of the interactive linked to it as `data_source_interactive`, and when a student presses Get Data it brings every table in as its own CODAP dataset.

## The object

A snapshot is a `StoredObject` with `subType: "multi-value-snapshot"`. Leave `type` as `untyped` and let the library choose the object id. Its display name is `description ?? name`, as for any saved object. Give the snapshot a name: a blank display name is shown, and used in titles, as `Data Set <n>`.

The `@concord-consortium/object-storage` version in use must have `addObject`. 1.0.0-pre.9 does.

## Tables

Each table is one `addDataTable` item:

- `id`: any item id except `tables`.
- `name`: the table's own name, without the snapshot's.
- `cols`: the column names, in order.
- `rows`: arrays parallel to `cols`, holding real JSON types. A short row leaves its remaining columns empty. CODAP trims leading and trailing whitespace from values, so a value of only whitespace arrives empty, while inner spaces stay.

Item `subType` is not read. Each table is stored as its own document, so the 1 MiB limit applies per table, and the writer is responsible for staying under it.

## The index

The snapshot has one index item, added with `addObject` under the fixed id `tables`:

```ts
{ tables: [{ id, colTypes }] }
```

- The order of `tables` is the table order.
- `id` is a data table's item id.
- `colTypes` is parallel to that table's `cols`, each `"categorical"` or `"numeric"`.

A data table the index does not name is ignored.

## Example

Here `objectStorage` is the interactive's `IObjectStorage` instance.

```ts
import { StoredObject } from "@concord-consortium/object-storage";

const snapshot = new StoredObject({ name: "Trial 1", subType: "multi-value-snapshot" });

snapshot.addDataTable({
  id: "readings",
  name: "Readings",
  cols: ["site", "depth", "temperature"],
  rows: [["north", 2, 14.5], ["south", 3, 12.1]]
});
snapshot.addDataTable({
  id: "sites",
  name: "Sites",
  cols: ["site", "visits"],
  rows: [["north", 4], ["south", 1]]
});
snapshot.addObject({
  id: "tables",
  name: "Tables",
  data: {
    tables: [
      { id: "readings", colTypes: ["categorical", "numeric", "numeric"] },
      { id: "sites", colTypes: ["categorical", "numeric"] }
    ]
  }
});

await objectStorage.add(snapshot);
```

## Reserved names

- Item id `tables` is the index.
- Columns may not be named `__objectId` or `__id__`.

## What is refused

The plugin shows a message and writes nothing to CODAP when:

- the index is missing or malformed, or `tables` is empty
- an `id` is not a string naming a data table in the object
- `colTypes` differs in length from `cols`, or holds another value
- the index names a table twice
- `cols` repeats a name or holds an empty name
- `cols` uses a reserved name
- every table is empty

An object with no data table at all is not listed, so no message appears.

## In CODAP

Every send gets its own datasets, one for each table with rows, and a table with no rows is skipped. Rows from one snapshot never go into another's dataset, even with the same columns or the same name.

- The dataset's title is `<snapshot display name>_<table name>`, such as "Trial 1_Readings". Two snapshots with the same name get matching titles and stay separate.
- It has one flat collection, named with the table's `name`, holding the columns in `cols` order with the types in `colTypes`.
- A hidden `__objectId` column records which snapshot the rows came from.

Each dataset opens as a case table, in index order, with the snapshot's rows selected.
