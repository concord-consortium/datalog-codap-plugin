import React, { useCallback, useEffect, useState } from "react";
import {
  createItems,
  createTable,
  getDataContext,
  initializePlugin,
  codapInterface,
  getAllItems,
} from "@concord-consortium/codap-plugin-api";
import "./App.css";
import { FakeDataSet } from "../types";
import { generateFakeDataSets } from "../utils/fake-data";
import ScreenshotPlaceholder from "./screenshot-placeholder";

const kPluginName = "Datalog";
const kVersion = "0.0.1";
const kInitialDimensions = {
  width: 300,
  height: 400
};
const kDataContextName = "DatalogPluginData";

export const App = () => {
  const [fakeDataSets, setFakeDataSets] = useState<FakeDataSet[]>(generateFakeDataSets());
  const [selectedDataSet, setSelectedDataSet] = useState<FakeDataSet | null>(fakeDataSets[0]);

  useEffect(() => {
    initializePlugin({ pluginName: kPluginName, version: kVersion, dimensions: kInitialDimensions });
  }, []);

  const highlightDataSet = useCallback(async (dataSet: FakeDataSet) => {
    const getResponse = await getAllItems(kDataContextName);
    if (getResponse.success) {
      const selectedIndexes: number[] = [];
      getResponse.values.forEach((item: any) => {
        if (item.values.name === dataSet.name) {
          selectedIndexes.push(item.id);
        }
      });
      await codapInterface.sendRequest({
        action: "create",
        resource: `dataContext[${kDataContextName}].selectionList`,
        values: selectedIndexes,
      });
    }
  }, []);

  const handleSelectDataSet = useCallback((dataSet: FakeDataSet) => {
    setSelectedDataSet(dataSet);

    if (dataSet.imported) {
      highlightDataSet(dataSet);
    }
  }, [highlightDataSet]);

  const handleGetData = useCallback(async () => {
    if (!selectedDataSet) return;

    setFakeDataSets(prevDataSets =>
      prevDataSets.map(ds =>
        ds.id === selectedDataSet.id ? { ...ds, imported: true } : ds
      )
    );
    setSelectedDataSet(prevSelected =>
      prevSelected ? { ...prevSelected, imported: true } : prevSelected
    );

    const existingDataContext = await getDataContext(kDataContextName);

    if (!existingDataContext.success) {
      await codapInterface.sendRequest({
        action: "create",
        resource: "dataContext",
        values: {
          name: kDataContextName,
          title: "Datalog Data",
          collections: [
            {
              name: "datasets",
              labels: {
                singleCase: "dataset",
                pluralCase: "datasets"
              },
              attrs: [
                { name: "name", type: "categorical" }
              ]
            },
            {
              name: "data",
              parent: "datasets",
              labels: {
                singleCase: "data",
                pluralCase: "data"
              },
              attrs: [
                { name: "time", type: "numeric" },
                { name: "wolves", type: "numeric" },
                { name: "sheep", type: "numeric" },
                { name: "vegetation", type: "numeric" }
              ]
            }
          ]
        }
      });
    }

    // create the items
    const items = selectedDataSet.data.map(row => ({
      name: selectedDataSet.name,
      time: row.time,
      wolves: row.wolves,
      sheep: row.sheep,
      vegetation: row.vegetation
    }));
    await createItems(kDataContextName, items);

    await createTable(kDataContextName);

    highlightDataSet(selectedDataSet);

  }, [selectedDataSet, highlightDataSet]);

  return (
    <div className="App">
      <div className="datasets">
        {fakeDataSets.map((dataSet) => (
          <div
            key={dataSet.id}
            className={`${selectedDataSet?.id === dataSet.id ? "selected" : ""} dataset`}
            onClick={() => handleSelectDataSet(dataSet)}
          >
            <span className="screenshot"><ScreenshotPlaceholder seed={dataSet.id} /></span>
            <span className="dataset-name">{dataSet.name}</span>
            <span className="dataset-length">({Math.round(dataSet.length / 1000)} sec)</span>
          </div>
        ))}
      </div>
      <div className="buttons">
        <button onClick={handleGetData} disabled={!selectedDataSet || selectedDataSet.imported}>
          Get Data
        </button>
      </div>
    </div>
  );
};
