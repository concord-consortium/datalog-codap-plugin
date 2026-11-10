import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  codapInterface, createItems, createTable, getAllItems, getDataContext, getItemByIndex, getListOfDataContexts,
  initializePlugin
} from "@concord-consortium/codap-plugin-api";
import { createObjectStorage } from "@concord-consortium/object-storage";
import { App } from "./App";
import { codapRequestStub, storageStub } from "../test/app-harness";
import { datasetName } from "../snapshot/import-snapshot";

jest.mock("@concord-consortium/codap-plugin-api", () => ({
  codapInterface: { on: jest.fn(), sendRequest: jest.fn() },
  createItems: jest.fn(),
  createTable: jest.fn(),
  getAllItems: jest.fn(),
  getDataContext: jest.fn(),
  getItemByIndex: jest.fn(),
  getListOfDataContexts: jest.fn(),
  initializePlugin: jest.fn()
}));

jest.mock("@concord-consortium/object-storage", () => ({ createObjectStorage: jest.fn() }));

const kPlainFailure = "This saved data could not be brought into CODAP.";

const snapshot = {
  id: "snapshot-1",
  metadata: {
    type: "untyped",
    subType: "multi-value-snapshot",
    name: "Data1",
    items: {
      words: { type: "dataTable", name: "Words", cols: ["word", "count"] },
      tables: { type: "object", name: "Tables", keys: ["tables"] }
    }
  }
};

const recording = {
  id: "recording-1",
  metadata: {
    type: "simulation-recording",
    subType: "agent-simulation",
    name: "Recording",
    items: { ticks: { type: "dataTable", name: "Ticks", cols: ["tick"] } }
  }
};

const validItemData = {
  tables: { tables: [{ id: "words", colTypes: ["categorical", "numeric"] }] },
  words: { rows: [["the", 2], ["cat", 1]] }
};

const kDataset = datasetName(snapshot.id, 0);

let itemData: Record<string, any>;
let codapItems: Map<string, any[]>;
let readDataItem: jest.Mock;

const sendRequest = codapInterface.sendRequest as jest.Mock;
const createItemsMock = createItems as jest.Mock;
const createTableMock = createTable as jest.Mock;
const getDataContextMock = getDataContext as jest.Mock;

const datasetRequests = () => sendRequest.mock.calls
  .map(([request]) => request)
  .filter(request => request.resource.startsWith("dataContext"));

const mountWith = (objects: any[]) => {
  readDataItem = jest.fn(async (_objectId: string, itemId: string) => itemData[itemId]);
  (createObjectStorage as jest.Mock).mockReturnValue(storageStub(objects, readDataItem));
  render(<App />);
};

const renderWith = async (objects: any[]) => {
  mountWith(objects);
  await screen.findByText("Get Data");
};

const getDataButton = () => screen.getByRole("button", { name: "Get Data" });

const pressGetData = (name: string) => {
  fireEvent.click(screen.getByText(name));
  fireEvent.click(getDataButton());
};

describe("bringing in a snapshot", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    itemData = { ...validItemData };
    codapItems = new Map();
    sendRequest.mockImplementation(codapRequestStub);
    createItemsMock.mockImplementation(async (dataset: string, items: any[]) => {
      codapItems.set(dataset, items.map((item, index) => ({ id: index + 1, values: item.values })));
      return { success: true };
    });
    createTableMock.mockResolvedValue({ success: true });
    getDataContextMock.mockResolvedValue({ success: false });
    (getAllItems as jest.Mock).mockImplementation(async (dataset: string) => (
      codapItems.has(dataset) ? { success: true, values: codapItems.get(dataset) } : { success: false }
    ));
    (getItemByIndex as jest.Mock).mockImplementation(async (dataset: string, index: number) => {
      const item = codapItems.get(dataset)?.[index];
      return { success: !!item, values: item };
    });
    (getListOfDataContexts as jest.Mock).mockImplementation(async () => (
      { success: true, values: [...codapItems.keys()].map(name => ({ name })) }
    ));
    (initializePlugin as jest.Mock).mockResolvedValue(undefined);
    jest.spyOn(window, "alert").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("imports without touching DatalogPluginData, then disables Get Data", async () => {
    await renderWith([snapshot]);
    pressGetData("Data1");

    await waitFor(() => expect(getDataButton()).toHaveProperty("disabled", true));

    expect(createItemsMock.mock.calls.map(([dataset]) => dataset)).toEqual([kDataset]);
    expect(createTableMock.mock.calls).toEqual([[kDataset]]);
    expect(getDataContextMock).not.toHaveBeenCalled();
    expect(datasetRequests().filter(request => request.resource === "dataContext").map(request => request.values.name))
      .toEqual([kDataset]);
    expect(datasetRequests().every(request => !request.resource.includes("DatalogPluginData"))).toBe(true);
  });

  it("imports once when Get Data is pressed twice", async () => {
    await renderWith([snapshot]);
    pressGetData("Data1");
    fireEvent.click(getDataButton());

    await waitFor(() => expect(getDataButton()).toHaveProperty("disabled", true));

    expect(createItemsMock).toHaveBeenCalledTimes(1);
  });

  it("disables Get Data and shows Importing… until the import settles", async () => {
    let finish: (reply: unknown) => void = () => undefined;
    createItemsMock.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await renderWith([snapshot]);
    expect(screen.getByRole("status").textContent).toBe("");
    pressGetData("Data1");

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Importing…"));
    expect(getDataButton()).toHaveProperty("disabled", true);

    finish({ success: false });

    await waitFor(() => expect(window.alert).toHaveBeenCalled());
    expect(screen.getByRole("status").textContent).toBe("");
    expect(getDataButton()).toHaveProperty("disabled", false);
  });

  it("alerts with the reason and sends CODAP nothing for a malformed index", async () => {
    itemData.tables = { tables: [] };
    await renderWith([snapshot]);
    pressGetData("Data1");

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith(`${kPlainFailure} The snapshot has no table index.`));

    expect(datasetRequests().filter(request => request.action !== "get")).toEqual([]);
    expect(createItemsMock).not.toHaveBeenCalled();
  });

  it("alerts the plain sentence for a string rejection and leaves Get Data enabled", async () => {
    createItemsMock.mockRejectedValueOnce("handleResponse: CODAP request timed out: [{...}]");
    await renderWith([snapshot]);
    pressGetData("Data1");

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith(kPlainFailure));

    expect(getDataButton()).toHaveProperty("disabled", false);
  });

  it("allows another press after a failed import", async () => {
    createItemsMock.mockRejectedValueOnce("timed out");
    await renderWith([snapshot]);
    pressGetData("Data1");
    await waitFor(() => expect(window.alert).toHaveBeenCalled());

    fireEvent.click(getDataButton());

    await waitFor(() => expect(getDataButton()).toHaveProperty("disabled", true));
    expect(createItemsMock).toHaveBeenCalledTimes(2);
  });

  it("alerts and writes nothing when the snapshot's dataset already holds rows", async () => {
    codapItems.set(kDataset, [{ id: 1, values: { __objectId: snapshot.id } }]);
    (getItemByIndex as jest.Mock).mockRejectedValueOnce("timed out");
    await renderWith([snapshot]);
    pressGetData("Data1");

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith(`${kPlainFailure} It is already in CODAP.`));
    expect(createItemsMock).not.toHaveBeenCalled();
    expect(datasetRequests().filter(request => request.resource === "dataContext")).toEqual([]);
    expect(datasetRequests().filter(request => request.action === "delete")).toEqual([]);
  });

  it("shows a snapshot found at load as imported, with DatalogPluginData absent", async () => {
    codapItems.set(kDataset, [{ id: 1, values: { __objectId: snapshot.id } }]);
    await renderWith([snapshot]);
    fireEvent.click(screen.getByText("Data1"));

    await waitFor(() => expect(getDataButton()).toHaveProperty("disabled", true));
  });

  it("shows both a snapshot and a recording found at load as imported", async () => {
    codapItems.set(kDataset, [{ id: 1, values: { __objectId: snapshot.id } }]);
    codapItems.set("DatalogPluginData", [{ id: 2, values: { name: "Recording", __objectId: recording.id } }]);
    await renderWith([snapshot, recording]);

    fireEvent.click(screen.getByText("Data1"));
    await waitFor(() => expect(getDataButton()).toHaveProperty("disabled", true));

    fireEvent.click(screen.getByText("Recording"));
    await waitFor(() => expect(sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ resource: "dataContext[DatalogPluginData].selectionList" })
    ));
    expect(getDataButton()).toHaveProperty("disabled", true);
  });

  it("titles datasets with the snapshot's display name", async () => {
    const described = { ...snapshot, metadata: { ...snapshot.metadata, description: "Shown" } };
    await renderWith([described]);
    pressGetData("Shown");

    await waitFor(() => expect(getDataButton()).toHaveProperty("disabled", true));

    expect(datasetRequests().find(request => request.resource === "dataContext").values.title).toBe("Shown_Words");
  });

  it("shows no list until it knows what is imported", async () => {
    let finishScan: (result: any) => void = () => undefined;
    (getListOfDataContexts as jest.Mock).mockReturnValue(new Promise(resolve => { finishScan = resolve; }));
    mountWith([snapshot]);
    await waitFor(() => expect(getListOfDataContexts).toHaveBeenCalled());

    expect(screen.queryByText("Get Data")).toBeNull();

    finishScan({ success: true, values: [] });

    await screen.findByText("Get Data");
  });

  it("still shows the list when the load scan rejects", async () => {
    (getAllItems as jest.Mock).mockRejectedValue("timed out");
    await renderWith([snapshot]);

    expect(console.error).toHaveBeenCalledWith("Failed to find imported data:", "timed out");
  });

  it("keeps a snapshot's imported state when the DatalogPluginData read rejects", async () => {
    codapItems.set(kDataset, [{ id: 1, values: { __objectId: snapshot.id } }]);
    (getAllItems as jest.Mock).mockImplementation(async (dataset: string) => {
      if (dataset === "DatalogPluginData") throw new Error("timed out");
      return { success: true, values: codapItems.get(dataset) };
    });
    await renderWith([snapshot]);

    fireEvent.click(screen.getByText("Data1"));

    await waitFor(() => expect(getDataButton()).toHaveProperty("disabled", true));
  });

  it("keeps a recording's imported state when a snapshot dataset cannot be read", async () => {
    codapItems.set(kDataset, [{ id: 1, values: { __objectId: snapshot.id } }]);
    codapItems.set("DatalogPluginData", [{ id: 2, values: { name: "Recording", __objectId: recording.id } }]);
    (getItemByIndex as jest.Mock).mockRejectedValueOnce("timed out");
    await renderWith([snapshot, recording]);

    fireEvent.click(screen.getByText("Recording"));

    await waitFor(() => expect(getDataButton()).toHaveProperty("disabled", true));
  });

  it("lists a snapshot with no reads", async () => {
    await renderWith([snapshot]);

    screen.getByText("Data1");
    expect(readDataItem).not.toHaveBeenCalled();
  });

  it("selects a snapshot by id and a recording by name", async () => {
    codapItems.set(kDataset, [
      { id: 1, values: { __objectId: snapshot.id } },
      { id: 2, values: { __objectId: "another-snapshot" } }
    ]);
    codapItems.set("DatalogPluginData", [
      { id: 3, values: { name: "Recording", __objectId: recording.id } },
      { id: 4, values: { name: "Data1", __objectId: recording.id } }
    ]);
    await renderWith([snapshot, recording]);

    fireEvent.click(screen.getByText("Data1"));
    await waitFor(() => expect(sendRequest).toHaveBeenCalledWith({
      action: "create", resource: `dataContext[${kDataset}].selectionList`, values: [1]
    }));

    fireEvent.click(screen.getByText("Recording"));
    await waitFor(() => expect(sendRequest).toHaveBeenCalledWith({
      action: "create", resource: "dataContext[DatalogPluginData].selectionList", values: [3]
    }));
  });
});
