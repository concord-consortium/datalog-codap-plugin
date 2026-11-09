import {
  codapInterface, createItems, createTable, getAllItems, getItemByIndex, getListOfDataContexts
} from "@concord-consortium/codap-plugin-api";
import { DemoObjectStorage, StoredObject } from "@concord-consortium/object-storage";
import { datasetName, findImportedSnapshotIds, importSnapshot, selectSnapshotRows } from "./import-snapshot";

jest.mock("@concord-consortium/codap-plugin-api", () => ({
  codapInterface: { sendRequest: jest.fn() },
  createItems: jest.fn(),
  createTable: jest.fn(),
  getAllItems: jest.fn(),
  getItemByIndex: jest.fn(),
  getListOfDataContexts: jest.fn()
}));

interface FakeDataset {
  request: any;
  items: { id: number; values: Record<string, unknown> }[];
}

let datasets: Map<string, FakeDataset>;
let selections: Map<string, number[]>;
let nextItemId: number;

const sendRequest = codapInterface.sendRequest as jest.Mock;
const createItemsMock = createItems as jest.Mock;
const createTableMock = createTable as jest.Mock;

const fakeSendRequest = async (request: any) => {
  const { action, resource, values } = request;
  if (action === "create" && resource === "dataContext") {
    if (!datasets.has(values.name)) datasets.set(values.name, { request, items: [] });
    return { success: true };
  }
  const selection = /^dataContext\[(.*)\]\.selectionList$/.exec(resource);
  if (action === "create" && selection) {
    selections.set(selection[1], values);
    return { success: true };
  }
  const search = /^dataContext\[(.*)\]\.itemSearch\[__objectId==(.*)\]$/.exec(resource);
  if (action === "delete" && search) {
    const dataset = datasets.get(search[1]);
    if (dataset) dataset.items = dataset.items.filter(item => item.values.__objectId !== search[2]);
    return { success: true };
  }
  const deletion = /^dataContext\[(.*)\]$/.exec(resource);
  if (action === "delete" && deletion) {
    datasets.delete(deletion[1]);
    return { success: true };
  }
  throw new Error(`Unexpected request: ${JSON.stringify(request)}`);
};

const fakeCreateItems = async (name: string, items: any[]) => {
  items.forEach(item => datasets.get(name)?.items.push({ id: nextItemId++, values: item.values }));
  return { success: true };
};

const addDataset = (name: string, values: Record<string, unknown>[]) => {
  datasets.set(name, { request: {}, items: values.map(itemValues => ({ id: nextItemId++, values: itemValues })) });
};

const rowsOf = (name: string) => datasets.get(name)?.items.map(item => item.values);
const collectionOf = (name: string) => datasets.get(name)?.request.values.collections[0];
const titleOf = (name: string) => datasets.get(name)?.request.values.title;

interface TableFixture {
  id: string;
  name: string;
  cols: string[];
  colTypes: string[];
  rows: any[][];
}

const words: TableFixture = {
  id: "words",
  name: "Words",
  cols: ["word", "count"],
  colTypes: ["categorical", "numeric"],
  rows: [["the", 2], ["cat", 1]]
};
const pairs: TableFixture = {
  id: "pairs",
  name: "Pairs",
  cols: ["from", "to"],
  colTypes: ["categorical", "categorical"],
  rows: [["the", "cat"]]
};
const empty: TableFixture = { id: "empty", name: "Empty", cols: ["x"], colTypes: ["numeric"], rows: [] };

const makeSnapshot = (id: string, tables: TableFixture[], savedOrder = tables) => {
  const object = new StoredObject({ id, subType: "multi-value-snapshot" });
  savedOrder.forEach(({ id: itemId, name, cols, rows }) => object.addDataTable({ id: itemId, name, cols, rows }));
  object.addObject({
    id: "tables",
    name: "Tables",
    data: { tables: tables.map(({ id: itemId, colTypes }) => ({ id: itemId, colTypes })) }
  });
  return object;
};

const makeStorage = async (...objects: StoredObject[]) => {
  const storage = new DemoObjectStorage({ version: 1, type: "demo" });
  for (const object of objects) await storage.add(object);
  return storage;
};

const importObject = async (storage: DemoObjectStorage, object: StoredObject, name: string) =>
  importSnapshot(storage, object.id, name, object.metadata);

describe("import-snapshot", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    datasets = new Map();
    selections = new Map();
    nextItemId = 1;
    sendRequest.mockReset().mockImplementation(fakeSendRequest);
    createItemsMock.mockReset().mockImplementation(fakeCreateItems);
    createTableMock.mockReset().mockResolvedValue({ success: true });
    (getListOfDataContexts as jest.Mock).mockImplementation(async () => (
      { success: true, values: [...datasets.keys()].map(name => ({ name })) }
    ));
    (getAllItems as jest.Mock).mockImplementation(async (name: string) => (
      { success: true, values: datasets.get(name)?.items ?? [] }
    ));
    (getItemByIndex as jest.Mock).mockImplementation(async (name: string, index: number) => {
      const item = datasets.get(name)?.items[index];
      return item ? { success: true, values: item } : { success: false, values: { error: "not found" } };
    });
  });

  describe("datasetName", () => {
    it("differs by object id and by table position", () => {
      expect(datasetName("a", 0)).not.toEqual(datasetName("b", 0));
      expect(datasetName("a", 0)).not.toEqual(datasetName("a", 1));
    });
  });

  describe("importSnapshot", () => {
    it("gives two snapshots with identical tables separate datasets", async () => {
      const first = makeSnapshot("first", [words]);
      const second = makeSnapshot("second", [words]);
      const storage = await makeStorage(first, second);

      await importObject(storage, first, "Data1");
      await importObject(storage, second, "Data2");

      expect(rowsOf(datasetName("first", 0))?.map(row => row.__objectId)).toEqual(["first", "first"]);
      expect(rowsOf(datasetName("second", 0))?.map(row => row.__objectId)).toEqual(["second", "second"]);
    });

    it("keeps two snapshots with the same name separate, with matching titles", async () => {
      const first = makeSnapshot("first", [words]);
      const second = makeSnapshot("second", [words]);
      const storage = await makeStorage(first, second);

      await importObject(storage, first, "Data1");
      await importObject(storage, second, "Data1");

      expect(datasets.size).toBe(2);
      expect(titleOf(datasetName("first", 0))).toBe("Data1_Words");
      expect(titleOf(datasetName("second", 0))).toBe("Data1_Words");
    });

    it("titles each dataset with the snapshot's name and the table's name", async () => {
      const first = makeSnapshot("first", [words, pairs]);
      const second = makeSnapshot("second", [words]);
      const storage = await makeStorage(first, second);

      await importObject(storage, first, "Data1");
      await importObject(storage, second, "Drawing1");

      expect(titleOf(datasetName("first", 0))).toBe("Data1_Words");
      expect(titleOf(datasetName("first", 1))).toBe("Data1_Pairs");
      expect(titleOf(datasetName("second", 0))).toBe("Drawing1_Words");
    });

    it("creates one flat collection with typed columns in order and a hidden object id", async () => {
      const object = makeSnapshot("first", [words]);

      await importObject(await makeStorage(object), object, "Data1");

      expect(datasets.get(datasetName("first", 0))?.request.values.collections).toEqual([
        {
          name: "Words",
          attrs: [
            { name: "word", type: "categorical" },
            { name: "count", type: "numeric" },
            { name: "__objectId", type: "categorical", hidden: true }
          ]
        }
      ]);
    });

    it("sends rows as values, leaving a short row's last column undefined", async () => {
      const table = { ...words, cols: ["id", "word"], rows: [[7, "the"], [7]] };
      const object = makeSnapshot("first", [table]);

      await importObject(await makeStorage(object), object, "Data1");

      expect(createItemsMock).toHaveBeenCalledWith(datasetName("first", 0), [
        { values: { __objectId: "first", id: 7, word: "the" } },
        { values: { __objectId: "first", id: 7, word: undefined } }
      ]);
    });

    it.each([
      ["answers with nothing", async () => undefined, 'Table "Pairs" could not be read.'],
      ["rejects", async () => { throw new Error("read failed"); }, "read failed"]
    ])("sends CODAP nothing when the last table's read %s", async (_description, failingRead, message) => {
      const object = makeSnapshot("first", [words, pairs]);
      const storage = await makeStorage(object);
      const realRead = storage.readDataItem.bind(storage);
      jest.spyOn(storage, "readDataItem").mockImplementation(
        (objectId, itemId) => itemId === "pairs" ? failingRead() : realRead(objectId, itemId)
      );

      await expect(importObject(storage, object, "Data1")).rejects.toThrow(message);

      expect(sendRequest).not.toHaveBeenCalled();
      expect(createItemsMock).not.toHaveBeenCalled();
      expect(createTableMock).not.toHaveBeenCalled();
    });

    it("sends CODAP nothing when the index is missing", async () => {
      const object = new StoredObject({ id: "first", subType: "multi-value-snapshot" });
      object.addDataTable({ id: "words", name: "Words", cols: ["word"], rows: [["the"]] });

      await expect(importObject(await makeStorage(object), object, "Data1"))
        .rejects.toThrow("The snapshot has no table index.");

      expect(sendRequest).not.toHaveBeenCalled();
    });

    it("skips an empty table without shifting the next table's dataset name", async () => {
      const object = makeSnapshot("first", [empty, words]);

      await importObject(await makeStorage(object), object, "Data1");

      expect([...datasets.keys()]).toEqual([datasetName("first", 1)]);
      expect(rowsOf(datasetName("first", 1))).toHaveLength(2);
    });

    it.each([
      ["a null row", { rows: [["the"], null] }],
      ["a row that is not a list", { rows: [["the"], "cat"] }],
      ["rows that are not a list", { rows: "the" }]
    ])("sends CODAP nothing for %s", async (_description, stored) => {
      const object = makeSnapshot("first", [words, pairs]);
      const storage = await makeStorage(object);
      const realRead = storage.readDataItem.bind(storage);
      jest.spyOn(storage, "readDataItem").mockImplementation(
        async (objectId, itemId) => itemId === "pairs" ? stored : realRead(objectId, itemId)
      );

      await expect(importObject(storage, object, "Data1")).rejects.toThrow('Table "Pairs" has invalid rows.');

      expect(sendRequest).not.toHaveBeenCalled();
    });

    it("refuses to write when one of its datasets already holds rows", async () => {
      const object = makeSnapshot("first", [words, pairs]);
      addDataset(datasetName("first", 1), [{ __objectId: "first" }]);

      await expect(importObject(await makeStorage(object), object, "Data1"))
        .rejects.toThrow("It is already in CODAP.");

      expect(sendRequest).not.toHaveBeenCalled();
      expect(createItemsMock).not.toHaveBeenCalled();
      expect(rowsOf(datasetName("first", 1))).toHaveLength(1);
    });

    it("writes nothing more on a retry after a delete failed", async () => {
      const object = makeSnapshot("first", [words, pairs]);
      const storage = await makeStorage(object);
      createItemsMock.mockImplementationOnce(fakeCreateItems).mockRejectedValueOnce("timed out");
      sendRequest.mockImplementation(async request => {
        if (request.action === "delete") throw new Error("delete failed");
        return fakeSendRequest(request);
      });
      await expect(importObject(storage, object, "Data1")).rejects.toBe("timed out");

      await expect(importObject(storage, object, "Data1")).rejects.toThrow("It is already in CODAP.");

      expect(rowsOf(datasetName("first", 0))).toHaveLength(2);
    });

    it("empties a reused dataset when the import fails, so a retry succeeds", async () => {
      const object = makeSnapshot("first", [words, pairs]);
      const storage = await makeStorage(object);
      addDataset(datasetName("first", 0), []);
      createItemsMock.mockImplementationOnce(fakeCreateItems).mockRejectedValueOnce("timed out");

      await expect(importObject(storage, object, "Data1")).rejects.toBe("timed out");

      expect(rowsOf(datasetName("first", 0))).toEqual([]);
      expect(datasets.has(datasetName("first", 1))).toBe(false);

      await importObject(storage, object, "Data1");

      expect(rowsOf(datasetName("first", 0))).toHaveLength(2);
      expect(rowsOf(datasetName("first", 1))).toHaveLength(1);
    });

    it("empties a reused dataset whose rows land after their request times out", async () => {
      const object = makeSnapshot("first", [words]);
      addDataset(datasetName("first", 0), []);
      createItemsMock.mockImplementationOnce(async (name: string, items: any[]) => {
        await fakeCreateItems(name, items);
        throw "timed out";
      });

      await expect(importObject(await makeStorage(object), object, "Data1")).rejects.toBe("timed out");

      expect(rowsOf(datasetName("first", 0))).toEqual([]);
      expect(sendRequest).toHaveBeenCalledWith({
        action: "delete", resource: `dataContext[${datasetName("first", 0)}].itemSearch[__objectId==first]`
      });
    });

    it("skips a table whose stored item has no rows", async () => {
      const object = makeSnapshot("first", [empty, words]);
      const storage = await makeStorage(object);
      const realRead = storage.readDataItem.bind(storage);
      jest.spyOn(storage, "readDataItem").mockImplementation(
        async (objectId, itemId) => itemId === "empty" ? {} : realRead(objectId, itemId)
      );

      await importObject(storage, object, "Data1");

      expect([...datasets.keys()]).toEqual([datasetName("first", 1)]);
    });

    it("refuses a snapshot in which every table is empty", async () => {
      const object = makeSnapshot("first", [empty]);

      await expect(importObject(await makeStorage(object), object, "Data1"))
        .rejects.toThrow("The snapshot has no rows.");

      expect(sendRequest).not.toHaveBeenCalled();
    });

    it("opens the case tables in index order", async () => {
      const object = makeSnapshot("first", [pairs, words], [words, pairs]);

      await importObject(await makeStorage(object), object, "Data1");

      expect(createTableMock.mock.calls).toEqual([[datasetName("first", 0)], [datasetName("first", 1)]]);
      expect(collectionOf(datasetName("first", 0)).name).toBe("Pairs");
      expect(collectionOf(datasetName("first", 1)).name).toBe("Words");
    });

    it("rejects, naming the title, when CODAP refuses a dataset", async () => {
      const object = makeSnapshot("first", [words]);
      sendRequest.mockResolvedValueOnce({ success: false });

      await expect(importObject(await makeStorage(object), object, "Data1"))
        .rejects.toThrow('CODAP refused the table "Data1_Words".');
    });

    it("rejects, naming the title, when CODAP refuses the second table's rows", async () => {
      const object = makeSnapshot("first", [words, pairs]);
      createItemsMock.mockImplementationOnce(fakeCreateItems).mockResolvedValueOnce({ success: false });

      await expect(importObject(await makeStorage(object), object, "Data1"))
        .rejects.toThrow('CODAP refused the rows of "Data1_Pairs".');
    });

    it("removes every dataset of a failed import, so a second import starts clean", async () => {
      const object = makeSnapshot("first", [words, pairs]);
      const storage = await makeStorage(object);
      const failure = "timed out";
      createItemsMock.mockImplementationOnce(fakeCreateItems).mockRejectedValueOnce(failure);

      await expect(importObject(storage, object, "Data1")).rejects.toBe(failure);

      const deletes = sendRequest.mock.calls.map(([request]) => request).filter(request => request.action === "delete");
      expect(deletes.map(request => request.resource)).toEqual([
        `dataContext[${datasetName("first", 0)}]`,
        `dataContext[${datasetName("first", 1)}]`
      ]);
      expect(datasets.size).toBe(0);

      await importObject(storage, object, "Data1");

      expect(rowsOf(datasetName("first", 0))).toHaveLength(2);
      expect(rowsOf(datasetName("first", 1))).toHaveLength(1);
    });

    it("treats an empty reply to a write as refused", async () => {
      const object = makeSnapshot("first", [words, pairs]);
      createItemsMock.mockImplementationOnce(fakeCreateItems).mockResolvedValueOnce(undefined);

      await expect(importObject(await makeStorage(object), object, "Data1"))
        .rejects.toThrow('CODAP refused the rows of "Data1_Pairs".');

      expect(datasets.size).toBe(0);
    });

    it("removes every dataset when CODAP refuses the second dataset", async () => {
      const object = makeSnapshot("first", [words, pairs]);
      sendRequest.mockImplementation(async request => (
        request.values?.title === "Data1_Pairs" ? { success: false } : fakeSendRequest(request)
      ));

      await expect(importObject(await makeStorage(object), object, "Data1"))
        .rejects.toThrow('CODAP refused the table "Data1_Pairs".');

      expect(datasets.size).toBe(0);
    });

    it("removes every dataset when CODAP refuses a case table", async () => {
      const object = makeSnapshot("first", [words, pairs]);
      createTableMock.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });

      await expect(importObject(await makeStorage(object), object, "Data1"))
        .rejects.toThrow('CODAP refused a case table for "Data1_Pairs".');

      expect(datasets.size).toBe(0);
    });

    it("removes every dataset when a case table request rejects", async () => {
      const object = makeSnapshot("first", [words, pairs]);
      createTableMock.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce("timed out");

      await expect(importObject(await makeStorage(object), object, "Data1")).rejects.toBe("timed out");

      expect(datasets.size).toBe(0);
    });

    it("removes every dataset when the selection rejects, so a second import starts clean", async () => {
      const object = makeSnapshot("first", [words, pairs]);
      const storage = await makeStorage(object);
      let failed = false;
      sendRequest.mockImplementation(async request => {
        if (!failed && request.resource.endsWith(".selectionList")) {
          failed = true;
          throw "timed out";
        }
        return fakeSendRequest(request);
      });

      await expect(importObject(storage, object, "Data1")).rejects.toBe("timed out");

      expect(datasets.size).toBe(0);

      await importObject(storage, object, "Data1");

      expect(rowsOf(datasetName("first", 0))).toHaveLength(2);
      expect(rowsOf(datasetName("first", 1))).toHaveLength(1);
    });

    it("keeps the import when CODAP refuses the selection", async () => {
      const object = makeSnapshot("first", [words]);
      sendRequest.mockImplementation(async request => (
        request.resource.endsWith(".selectionList") ? { success: false } : fakeSendRequest(request)
      ));

      await importObject(await makeStorage(object), object, "Data1");

      expect(rowsOf(datasetName("first", 0))).toHaveLength(2);
    });

    it("rethrows the first failure and keeps cleaning up when a delete rejects", async () => {
      const object = makeSnapshot("first", [words, pairs]);
      const failure = "timed out";
      createItemsMock.mockImplementationOnce(fakeCreateItems).mockRejectedValueOnce(failure);
      sendRequest.mockImplementation(async request => {
        if (request.resource === `dataContext[${datasetName("first", 0)}]`) throw new Error("delete failed");
        return fakeSendRequest(request);
      });

      await expect(importObject(await makeStorage(object), object, "Data1")).rejects.toBe(failure);

      expect(sendRequest).toHaveBeenCalledWith({
        action: "delete", resource: `dataContext[${datasetName("first", 1)}]`
      });
    });

    it("rethrows the first failure and keeps cleaning up when a row delete rejects", async () => {
      const object = makeSnapshot("first", [words, pairs]);
      addDataset(datasetName("first", 0), []);
      createItemsMock.mockImplementationOnce(fakeCreateItems).mockRejectedValueOnce("timed out");
      sendRequest.mockImplementation(async request => {
        if (request.resource.includes(".itemSearch[")) throw new Error("delete failed");
        return fakeSendRequest(request);
      });

      await expect(importObject(await makeStorage(object), object, "Data1")).rejects.toBe("timed out");

      expect(sendRequest).toHaveBeenCalledWith({
        action: "delete", resource: `dataContext[${datasetName("first", 1)}]`
      });
      expect(datasets.has(datasetName("first", 1))).toBe(false);
    });

    it("selects the snapshot's rows in its own datasets", async () => {
      const object = makeSnapshot("first", [words, pairs]);

      await importObject(await makeStorage(object), object, "Data1");

      expect(selections.get(datasetName("first", 0))).toEqual([1, 2]);
      expect(selections.get(datasetName("first", 1))).toEqual([3]);
    });
  });

  describe("findImportedSnapshotIds", () => {
    it("returns ids from every snapshot dataset and ignores all other datasets", async () => {
      addDataset(datasetName("first", 0), [{ __objectId: "first" }]);
      addDataset(datasetName("second", 1), [{ __objectId: "second" }]);
      addDataset("DatalogPluginData", [{ __objectId: "recording" }]);
      addDataset("Unrelated", [{ __objectId: "other" }]);

      expect([...await findImportedSnapshotIds()].sort()).toEqual(["first", "second"]);
    });

    it("reads one item from each dataset, not all of them", async () => {
      addDataset(datasetName("first", 0), [{ __objectId: "first" }, { __objectId: "first" }]);

      await findImportedSnapshotIds();

      expect((getItemByIndex as jest.Mock).mock.calls).toEqual([[datasetName("first", 0), 0]]);
      expect(getAllItems).not.toHaveBeenCalled();
    });

    it("skips a dataset with no rows", async () => {
      addDataset(datasetName("first", 0), []);

      expect((await findImportedSnapshotIds()).size).toBe(0);
    });

    it("skips a dataset whose item cannot be read", async () => {
      addDataset(datasetName("first", 0), [{ __objectId: "first" }]);
      addDataset(datasetName("second", 0), [{ __objectId: "second" }]);
      (getItemByIndex as jest.Mock).mockResolvedValueOnce({ success: false, values: { error: "not found" } });

      expect([...await findImportedSnapshotIds()]).toEqual(["second"]);
    });

    it("skips a dataset whose read rejects", async () => {
      addDataset(datasetName("first", 0), [{ __objectId: "first" }]);
      addDataset(datasetName("second", 0), [{ __objectId: "second" }]);
      (getItemByIndex as jest.Mock).mockRejectedValueOnce("timed out");

      expect([...await findImportedSnapshotIds()]).toEqual(["second"]);
    });

    it("finds nothing when the dataset list read rejects", async () => {
      (getListOfDataContexts as jest.Mock).mockRejectedValueOnce("timed out");

      expect((await findImportedSnapshotIds()).size).toBe(0);
    });

    it("finds nothing when the dataset list cannot be read", async () => {
      (getListOfDataContexts as jest.Mock).mockResolvedValueOnce({ success: false, values: { error: "failed" } });

      expect((await findImportedSnapshotIds()).size).toBe(0);
    });
  });

  describe("selectSnapshotRows", () => {
    it("selects a snapshot's items and clears other snapshots' selections", async () => {
      addDataset(datasetName("first", 0), [{ __objectId: "first" }, { __objectId: "first" }]);
      addDataset(datasetName("second", 0), [{ __objectId: "second" }]);
      addDataset("DatalogPluginData", [{ __objectId: "recording" }]);

      await selectSnapshotRows("first");

      expect(selections.get(datasetName("first", 0))).toEqual([1, 2]);
      expect(selections.get(datasetName("second", 0))).toEqual([]);
      expect(selections.has("DatalogPluginData")).toBe(false);
      expect((getAllItems as jest.Mock).mock.calls).toEqual([[datasetName("first", 0)]]);
    });

    it("does not take a dataset of an id that starts with this one for its own", async () => {
      addDataset(datasetName("first", 0), [{ __objectId: "first" }]);
      addDataset(datasetName("first_1", 0), [{ __objectId: "first_1" }]);

      await selectSnapshotRows("first");

      expect((getAllItems as jest.Mock).mock.calls).toEqual([[datasetName("first", 0)]]);
      expect(selections.get(datasetName("first_1", 0))).toEqual([]);
    });

    it("sends no selection when the dataset list cannot be read", async () => {
      addDataset(datasetName("first", 0), [{ __objectId: "first" }]);
      (getListOfDataContexts as jest.Mock).mockResolvedValueOnce({ success: false, values: { error: "failed" } });

      await selectSnapshotRows("first");

      expect(selections.size).toBe(0);
    });

    it("selects nothing in a dataset whose items cannot be read", async () => {
      addDataset(datasetName("first", 0), [{ __objectId: "first" }]);
      (getAllItems as jest.Mock).mockResolvedValueOnce({ success: false, values: { error: "not found" } });

      await selectSnapshotRows("first");

      expect(selections.get(datasetName("first", 0))).toEqual([]);
    });
  });
});
