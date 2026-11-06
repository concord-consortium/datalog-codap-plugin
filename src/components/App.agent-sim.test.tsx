import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  codapInterface, createItems, createTable, getAllItems, getDataContext, getListOfDataContexts, initializePlugin
} from "@concord-consortium/codap-plugin-api";
import { createObjectStorage } from "@concord-consortium/object-storage";
import { App } from "./App";
import { codapRequestStub, storageStub } from "../test/app-harness";
import packageJson from "../../package.json";

jest.mock("@concord-consortium/codap-plugin-api", () => ({
  codapInterface: { on: jest.fn(), sendRequest: jest.fn() },
  createItems: jest.fn(),
  createTable: jest.fn(),
  getAllItems: jest.fn(),
  getDataContext: jest.fn(),
  getListOfDataContexts: jest.fn(),
  initializePlugin: jest.fn()
}));

jest.mock("@concord-consortium/object-storage", () => ({ createObjectStorage: jest.fn() }));

const kRecordingName = "Wolves: 12s (3s)";

const recordingItems = {
  "screenshot": { type: "image", subType: "simulation-screenshot", width: 800, height: 600 },
  "thumbnail": { type: "image", subType: "simulation-thumbnail", width: 80, height: 60 },
  "ticks": { type: "dataTable", subType: "simulation-tick-data", cols: ["tick", "wolves", "sheep"] },
  "code": { type: "text", subType: "simulation-code" }
};

const recording = {
  id: "recording-1",
  metadata: {
    type: "simulation-recording",
    subType: "agent-simulation",
    name: "Simulation Recording",
    description: kRecordingName,
    items: recordingItems
  }
};

const itemData: Record<string, any> = {
  ticks: { rows: [[0, 5, 50], [1, 6, 48], [2, 8, 41]] },
  second: { rows: [[99]] }
};

const expectedDataContext = {
  action: "create",
  resource: "dataContext",
  values: {
    name: "DatalogPluginData",
    title: "Datalog Data",
    collections: [
      {
        name: "datasets",
        labels: { singleCase: "dataset", pluralCase: "datasets" },
        attrs: [{ name: "name", type: "categorical" }]
      },
      {
        name: "data",
        parent: "datasets",
        labels: { singleCase: "data", pluralCase: "data" },
        attrs: [
          { name: "tick", type: "numeric" },
          { name: "wolves", type: "numeric" },
          { name: "sheep", type: "numeric" },
          { name: "__objectId", type: "categorical", hidden: true }
        ]
      }
    ]
  }
};

const expectedItems = (name: string, objectId: string) => [
  { name, __objectId: objectId, tick: 0, wolves: 5, sheep: 50 },
  { name, __objectId: objectId, tick: 1, wolves: 6, sheep: 48 },
  { name, __objectId: objectId, tick: 2, wolves: 8, sheep: 41 }
];

const sendRequest = codapInterface.sendRequest as jest.Mock;

const sentRequests = () => sendRequest.mock.calls.map(([request]) => request);

const renderWith = async (objects: any[]) => {
  (createObjectStorage as jest.Mock).mockReturnValue(
    storageStub(objects, jest.fn(async (_objectId: string, itemId: string) => itemData[itemId]))
  );
  render(<App />);
  await screen.findByText("Get Data");
};

const getData = async (name: string) => {
  fireEvent.click(screen.getByText(name));
  fireEvent.click(screen.getByText("Get Data"));
  await waitFor(() => expect(createTable).toHaveBeenCalled());
};

describe("importing an Agent Sim recording", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sendRequest.mockImplementation(codapRequestStub);
    (getAllItems as jest.Mock).mockResolvedValue({ success: false });
    (getDataContext as jest.Mock).mockResolvedValue({ success: false });
    (getListOfDataContexts as jest.Mock).mockResolvedValue({ success: true, values: [] });
    (createItems as jest.Mock).mockResolvedValue({ success: true });
    (createTable as jest.Mock).mockResolvedValue({ success: true });
    (initializePlugin as jest.Mock).mockResolvedValue(undefined);
  });

  it("creates the two-collection, all-numeric DatalogPluginData dataset", async () => {
    await renderWith([recording]);
    await getData(kRecordingName);

    expect(sentRequests().filter(request => request.resource === "dataContext")).toEqual([expectedDataContext]);
  });

  it("sends the items in row order", async () => {
    await renderWith([recording]);
    await getData(kRecordingName);

    expect(createItems).toHaveBeenCalledTimes(1);
    expect(createItems).toHaveBeenCalledWith("DatalogPluginData", expectedItems(kRecordingName, "recording-1"));
  });

  it("opens the DatalogPluginData table and touches no other dataset", async () => {
    (getAllItems as jest.Mock).mockResolvedValue({ success: true, values: [] });
    await renderWith([recording]);
    await getData(kRecordingName);

    expect((createTable as jest.Mock).mock.calls).toEqual([["DatalogPluginData"]]);
    expect((getDataContext as jest.Mock).mock.calls).toEqual([["DatalogPluginData"]]);
    expect(codapInterface.on).toHaveBeenCalledWith(
      "notify", "dataContext[DatalogPluginData].case", expect.any(Function)
    );
    await waitFor(() => expect(sentRequests().map(request => request.resource))
      .toContain("dataContext[DatalogPluginData].selectionList"));
    const datasetResources = sentRequests()
      .map(request => request.resource as string)
      .filter(resource => resource.startsWith("dataContext["));
    expect(datasetResources.every(resource => resource.startsWith("dataContext[DatalogPluginData]"))).toBe(true);
    expect((getAllItems as jest.Mock).mock.calls.every(([dataset]) => dataset === "DatalogPluginData")).toBe(true);
  });

  it("reports the version from package.json", async () => {
    await renderWith([recording]);

    expect(initializePlugin).toHaveBeenCalledWith(expect.objectContaining({ version: packageJson.version }));
  });

  it("takes an untyped object with one data table down the same path", async () => {
    const { ticks } = recordingItems;
    const untyped = {
      id: "untyped-1",
      metadata: { type: "untyped", name: "Early Recording", items: { ticks } }
    };
    await renderWith([untyped]);
    await getData("Early Recording");

    expect(sentRequests().filter(request => request.resource === "dataContext")).toEqual([expectedDataContext]);
    expect(createItems).toHaveBeenCalledWith("DatalogPluginData", expectedItems("Early Recording", "untyped-1"));
  });

  it("imports only the first of two data tables", async () => {
    const { ticks } = recordingItems;
    const twoTables = {
      id: "two-tables",
      metadata: {
        type: "untyped",
        name: "Two Tables",
        items: { ticks, second: { type: "dataTable", cols: ["other"] } }
      }
    };
    await renderWith([twoTables]);
    await getData("Two Tables");

    expect(createItems).toHaveBeenCalledTimes(1);
    expect(createItems).toHaveBeenCalledWith("DatalogPluginData", expectedItems("Two Tables", "two-tables"));
  });
});
