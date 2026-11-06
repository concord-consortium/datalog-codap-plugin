import { DemoObjectStorage, StoredObject } from "@concord-consortium/object-storage";
import { isSnapshot, kSnapshotIndexItemId, parseSnapshotTables } from "./multi-value-snapshot";

const makeSnapshot = () => {
  const object = new StoredObject({ name: "Data1", subType: "multi-value-snapshot" });
  object.addDataTable({ id: "words", name: "Words", cols: ["word", "count"], rows: [["the", 2]] });
  object.addDataTable({ id: "pairs", name: "Pairs", cols: ["from"], rows: [["the"]] });
  object.addDataTable({ id: "unlisted", name: "Unlisted", cols: ["x"], rows: [[1]] });
  object.addText({ id: "note", name: "Note", text: "a note" });
  return object;
};

const validIndex = {
  tables: [
    { id: "pairs", colTypes: ["categorical"] },
    { id: "words", colTypes: ["categorical", "numeric"] }
  ]
};

const metadataWithCols = (cols: string[]) => {
  const object = new StoredObject({ subType: "multi-value-snapshot" });
  object.addDataTable({ id: "t", name: "T", cols, rows: [] });
  return object.metadata;
};

const indexFor = (colTypes: unknown) => ({ tables: [{ id: "t", colTypes }] });

describe("isSnapshot", () => {
  it("is true only for the snapshot subType", () => {
    expect(isSnapshot(makeSnapshot().metadata)).toBe(true);
    expect(isSnapshot(new StoredObject({ type: "simulation-recording", subType: "agent-simulation" }).metadata))
      .toBe(false);
    expect(isSnapshot(new StoredObject().metadata)).toBe(false);
  });
});

describe("parseSnapshotTables", () => {
  it("reads a saved index, in index order, leaving out tables it does not name", async () => {
    const object = makeSnapshot();
    object.addObject({ id: "tables", name: "Tables", data: validIndex });
    const storage = new DemoObjectStorage({ version: 1, type: "demo" });
    await storage.add(object);

    const index = await storage.readDataItem(object.id, kSnapshotIndexItemId);

    expect(parseSnapshotTables(object.metadata, index)).toEqual([
      { id: "pairs", name: "Pairs", cols: ["from"], colTypes: ["categorical"] },
      { id: "words", name: "Words", cols: ["word", "count"], colTypes: ["categorical", "numeric"] }
    ]);
  });

  it.each([
    ["a missing index", undefined],
    ["an index with no tables key", {}],
    ["a tables value that is not a list", { tables: "words" }],
    ["an empty tables list", { tables: [] }]
  ])("refuses %s", (_description, index) => {
    expect(() => parseSnapshotTables(makeSnapshot().metadata, index)).toThrow("The snapshot has no table index.");
  });

  it("refuses an id that is not in the object", () => {
    const index = { tables: [{ id: "missing", colTypes: [] }] };
    expect(() => parseSnapshotTables(makeSnapshot().metadata, index))
      .toThrow('The index names "missing", which is not a data table.');
  });

  it("refuses an id that is not a data table", () => {
    const index = { tables: [{ id: "note", colTypes: [] }] };
    expect(() => parseSnapshotTables(makeSnapshot().metadata, index))
      .toThrow('The index names "note", which is not a data table.');
  });

  it("refuses an id that is not a string, even when it matches a table as text", () => {
    const metadata = metadataWithCols(["a"]);
    metadata.items["1"] = metadata.items.t;
    const index = { tables: [{ id: 1, colTypes: ["numeric"] }] };
    expect(() => parseSnapshotTables(metadata, index)).toThrow('The index names "1", which is not a data table.');
  });

  it("refuses an entry that is not an object", () => {
    expect(() => parseSnapshotTables(makeSnapshot().metadata, { tables: [null] }))
      .toThrow('The index names "undefined", which is not a data table.');
  });

  it.each([
    ["missing colTypes", undefined],
    ["too few colTypes", ["numeric"]],
    ["too many colTypes", ["numeric", "numeric", "numeric"]],
    ["an unknown colType", ["numeric", "date"]]
  ])("refuses %s", (_description, colTypes) => {
    expect(() => parseSnapshotTables(metadataWithCols(["a", "b"]), indexFor(colTypes)))
      .toThrow('Table "T" needs one categorical or numeric colType per column.');
  });

  it("refuses an index that names a table twice", () => {
    const index = { tables: [{ ...validIndex.tables[1] }, { ...validIndex.tables[1] }] };
    expect(() => parseSnapshotTables(makeSnapshot().metadata, index)).toThrow("The index names a table twice.");
  });

  it("refuses a repeated column name", () => {
    expect(() => parseSnapshotTables(metadataWithCols(["a", "a"]), indexFor(["numeric", "numeric"])))
      .toThrow('Table "T" repeats a column name.');
  });

  it("refuses an empty column name", () => {
    expect(() => parseSnapshotTables(metadataWithCols(["a", ""]), indexFor(["numeric", "numeric"])))
      .toThrow('Table "T" has a column with no name.');
  });

  it.each(["__objectId", "__id__"])("refuses the reserved column %s", col => {
    expect(() => parseSnapshotTables(metadataWithCols(["a", col]), indexFor(["numeric", "numeric"])))
      .toThrow('Table "T" uses a reserved column name.');
  });
});
