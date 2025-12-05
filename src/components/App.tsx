import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  createItems,
  createTable,
  getDataContext,
  initializePlugin,
  codapInterface,
  getAllItems,
} from "@concord-consortium/codap-plugin-api";

import {
  createObjectStorage, IObjectStorage, TypedObject, FirebaseObjectStorageConfig, TypedDataTableMetadata
} from "@concord-consortium/object-storage";

import "./App.css";

const kPluginName = "Datalog";
const kVersion = "0.0.1";
const kInitialDimensions = {
  width: 300,
  height: 400
};
const kDataContextName = "DatalogPluginData";

// for now we'll get linked interactives from the URL - this will change once we add
// CODAP authoring to LARA
const dataSourceInteractive = new URLSearchParams(window.location.search).get("dataSourceInteractive");

interface StoredObjectDataTable {
  name: string;
  objectId: string;
  dataTableMetadata: TypedDataTableMetadata;
  dataTableItemId: string;
}

export const App = () => {
  const [initialized, setInitialized] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [objectStorageConfig, setObjectStorageConfig] = useState<FirebaseObjectStorageConfig | null>(null);
  const objectStorageRef = useRef<IObjectStorage | null>(null);
  const [storedObjectDataTables, setStoredObjectDataTables] = useState<StoredObjectDataTable[]>([]);
  const [selectedDataTableObjectId, setSelectedDataTableObjectId] = useState<string | null>(null);
  const [importedDataTableIds, setImportedDataTableIds] = useState<Set<string>>(new Set());

  const addImportedDataTableId = useCallback((id: string) => {
    const add = async () => {
      setImportedDataTableIds(prev => new Set(prev).add(id));
      const newState = {
        importedDataTableIds: Array.from(importedDataTableIds).concat([id])
      };
      await codapInterface.updateInteractiveState(newState);
    };
    if (!importedDataTableIds.has(id)) {
      add();
    };
  }, [importedDataTableIds]);

  // initialize the plugin and get the Interactive API settings
  useEffect(() => {
    const init = async () => {
      await initializePlugin({ pluginName: kPluginName, version: kVersion, dimensions: kInitialDimensions });

      const interactiveState: any = await codapInterface.getInteractiveState();
      if (interactiveState?.importedDataTableIds) {
        setImportedDataTableIds(new Set(interactiveState.importedDataTableIds));
      }

      const result: any = await codapInterface.sendRequest({ action: "get", resource: "interactiveApi"});
      if (!result.success) {
        console.error("Failed to get Interactive API. Request result:", result);
        setFatalError("Failed to get Interactive API.  Make sure you are running this in CODAP v3 or later.");
        return;
      }

      if (!result.values?.available) {
        console.error("Interactive API is not available. Request result:", result);
        setFatalError("Interactive API is not available. Make sure you are running this in Activity Player.");
        return;
      }

      const { initInteractive } = result.values;
      if (!initInteractive) {
        console.error("Interactive API is not valid. Request result:", result);
        setFatalError("Interactive API result is not valid - initInteractive is missing.");
        return;
      }

      if (!initInteractive.objectStorageConfig) {
        console.error("The objectStorageConfig is missing in the Interactive API response:", initInteractive);
        // eslint-disable-next-line max-len
        setFatalError("The objectStorageConfig is missing in the Interactive API response.  Make sure you are using the latest version of Activity Player.");
        return;
      }

      if (!dataSourceInteractive) {
        console.error("The dataSourceInteractive query param is missing.");
        // eslint-disable-next-line max-len
        setFatalError("The dataSourceInteractive query param is missing.  Make sure to add a ?dataSourceInteractive=<id> query parameter to the URL.  This will be fixed once CODAP authoring is added to LARA.");
        return;
      }

      setObjectStorageConfig(initInteractive.objectStorageConfig);
    };

    init();
  }, []);

  // start listening to object storage
  useEffect(() => {
    if (fatalError || !objectStorageConfig || !dataSourceInteractive) {
      return;
    }

    if (!objectStorageRef.current) {
      objectStorageRef.current = createObjectStorage(objectStorageConfig);
    }
    const unsubscribe = objectStorageRef.current.monitor(dataSourceInteractive, (objects) => {
      const newStoredObjectDataTables: StoredObjectDataTable[] = [];

      let dataTableIndex = 1;
      objects.forEach(obj => {
        if (TypedObject.IsSupportedTypedObjectMetadata(obj.metadata)) {
          const dataTableItem = Object.entries(obj.metadata.items).find(([_, item]) => item.type === "dataTable");
          if (dataTableItem) {
            const [dataTableItemId, dataTableMetadata] = dataTableItem;
            let name = obj.metadata.description ?? obj.metadata.name;
            if (!name || name.trim().length === 0) {
              name = `Data Set ${dataTableIndex}`;
              dataTableIndex += 1;
            }

            newStoredObjectDataTables.push({
              name,
              objectId: obj.id,
              dataTableMetadata: dataTableMetadata as TypedDataTableMetadata,
              dataTableItemId
            });
          }
        }
      });
      setStoredObjectDataTables(newStoredObjectDataTables);
      setInitialized(true);
    });

    return () => {
      unsubscribe();
    };

  }, [objectStorageConfig, fatalError, initialized]);

  const highlightDataSet = useCallback(async (id: string) => {

    const highlightObject = storedObjectDataTables.find(dt => dt.objectId === id);

    const getResponse = await getAllItems(kDataContextName);
    if (getResponse.success) {
      const selectedIndexes: number[] = [];
      getResponse.values.forEach((item: any) => {
        if (item.values.name === highlightObject?.name) {
          selectedIndexes.push(item.id);
        }
      });
      await codapInterface.sendRequest({
        action: "create",
        resource: `dataContext[${kDataContextName}].selectionList`,
        values: selectedIndexes,
      });
    }
  }, [storedObjectDataTables]);

  const handleSelectDataTableId = useCallback((id: string) => {
    setSelectedDataTableObjectId(id);
    highlightDataSet(id);
  }, [highlightDataSet]);

  const handleGetData = useCallback(async () => {
    if (!selectedDataTableObjectId) return;

    const selectedDataTableObject = storedObjectDataTables.find(dt => dt.objectId === selectedDataTableObjectId);
    if (!selectedDataTableObject) {
      alert("Failed to get the selected object.");
      return;
    }

    const objectData = await objectStorageRef.current?.readData(selectedDataTableObjectId);
    if (!objectData) {
      alert("Failed to read the selected data table object from object storage.");
      return;
    }

    const dataTableData = objectData[selectedDataTableObject.dataTableItemId];
    if (!dataTableData) {
      alert("The selected object does not contain a data table item.");
      return;
    }

    const { cols } = selectedDataTableObject.dataTableMetadata;
    const attrs = cols.map((col: any) => ({name: col, type: "numeric"}));

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
              attrs
            }
          ]
        }
      });
    }

    // create the items
    const items = Object.values(dataTableData.rows || {}).map(rowValues => {
      const item: any = {
        name: selectedDataTableObject.name
      };
      cols.forEach((col, index) => {
        item[col] = (rowValues as any)[index];
      });
      return item;
    });
    await createItems(kDataContextName, items);

    await createTable(kDataContextName);

    highlightDataSet(selectedDataTableObjectId);

    addImportedDataTableId(selectedDataTableObjectId);

  }, [selectedDataTableObjectId, storedObjectDataTables, highlightDataSet, addImportedDataTableId]);

  const getDataDisabled = !selectedDataTableObjectId || importedDataTableIds.has(selectedDataTableObjectId);

  const renderApp = () => {
    if (fatalError) {
      return <div className="fatal-error">{fatalError}</div>;
    }
    if (!initialized) {
      return <div className="initializing">Initializing...</div>;
    }
    if (storedObjectDataTables.length === 0) {
      return <div className="no-data">No data tables were found.</div>;
    }

    return (
      <>
        <div className="datasets">
          {storedObjectDataTables.map(({objectId, name}) => (
            <div
              key={objectId}
              // eslint-disable-next-line max-len
              className={`${selectedDataTableObjectId === objectId ? "selected" : ""} ${importedDataTableIds.has(objectId) ? "imported" : ""} dataset`}
              onClick={() => handleSelectDataTableId(objectId)}
            >
              {/* <span className="screenshot"><ScreenshotPlaceholder seed={objectId} /></span> */}
              <span className="dataset-name">{name}</span>
            </div>
          ))}
        </div>
        <div className="buttons">
          <button onClick={handleGetData} disabled={getDataDisabled}>
            Get Data
          </button>
        </div>
      </>
    );
  };

  return (
    <div className="App">
      {renderApp()}
    </div>
  );
};
