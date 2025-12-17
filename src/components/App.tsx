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
  createObjectStorage, IObjectStorage, FirebaseObjectStorageConfig, StoredObjectDataTableMetadata,
  StoredImageMetadata
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
  dataTableMetadata: StoredObjectDataTableMetadata;
  dataTableItemId: string;
  thumbnailMetadata?: StoredImageMetadata;
  thumbnailItemId?: string;
}

export const App = () => {
  const [initialized, setInitialized] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [objectStorageConfig, setObjectStorageConfig] = useState<FirebaseObjectStorageConfig | null>(null);
  const objectStorageRef = useRef<IObjectStorage | null>(null);
  const [storedObjectDataTables, setStoredObjectDataTables] = useState<StoredObjectDataTable[]>([]);
  const [selectedDataTableObjectId, setSelectedDataTableObjectId] = useState<string | null>(null);
  const [importedDataTableIds, setImportedDataTableIds] = useState<Set<string>>(new Set());
  const [thumbnailUrls, setThumbnailUrls] = useState<Map<string, string>>(new Map());
  const fetchedThumbnailIds = useRef<Set<string>>(new Set());

  // initialize the plugin and get the Interactive API settings
  useEffect(() => {
    const init = async () => {
      await initializePlugin({ pluginName: kPluginName, version: kVersion, dimensions: kInitialDimensions });

      // hide the close button - this will be running in a shared CODAP doc inside Activity Player so we don't
      // want users accidentally closing it and then being unable to get it back
      await codapInterface.sendRequest({
        action: "update",
        resource: "interactiveFrame",
        values: { cannotClose: true }
      });

      const result: any = await codapInterface.sendRequest({ action: "get", resource: "interactiveApi"});
      if (!result.success) {
        console.error("Failed to get Interactive API. Request result:", result);
        // eslint-disable-next-line max-len
        setFatalError("Failed to connect to Interactive API.  Make sure you are running this in CODAP v3 or later under Activity Player.");
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

      // find all the current objects imported
      const checkAllCases = async () => {
          const getResponse = await getAllItems(kDataContextName);
          if (getResponse.success) {
            const importedIds = new Set<string>();
            getResponse.values.forEach((item: any) => {
              if (item.values.__objectId) {
                importedIds.add(item.values.__objectId);
              }
            });
            setImportedDataTableIds(importedIds);
          }
      };
      await checkAllCases();

      // start listening to data context changes in CODAP
      codapInterface.on("notify", `dataContext[${kDataContextName}].case`, (msg) => {
        const checkDeleted = async () => {
          await checkAllCases();
        };

        switch (msg.action) {
          case "create":
          case "update":
            setImportedDataTableIds(prev => {
              const newSet = new Set(prev);
              msg.values.cases.forEach((cases: any) => {
                if (cases.values.__objectId) {
                  newSet.add(cases.values.__objectId);
                }
              });
              return newSet;
            });
            break;

          case "delete":
            checkDeleted();
            break;
        }
      });
    };

    init();
  }, []);

  // start listening to object storage
  useEffect(() => {
    if (!objectStorageConfig || !dataSourceInteractive) {
      return;
    }

    if (!objectStorageRef.current) {
      objectStorageRef.current = createObjectStorage(objectStorageConfig);
    }
    const unsubscribe = objectStorageRef.current.monitor(dataSourceInteractive, (objects) => {
      const newStoredObjectDataTables: StoredObjectDataTable[] = [];

      let dataTableIndex = 1;
      objects.forEach(obj => {
        // eslint-disable-next-line max-len
        const imageItems = Object.entries(obj.metadata.items).filter(([_, item]) => item.type === "image") as [string, StoredImageMetadata][];
        let thumbnailItem = imageItems.find(([_, item]) => item.subType?.includes("thumbnail"));
        if (!thumbnailItem) {
          thumbnailItem = imageItems.reduce((prev, curr) => {
            const [, currItem] = curr;
            const [, prevItem] = prev;
            const curWidth = currItem.width ?? Number.MAX_VALUE;
            const curHeight = currItem.height ?? Number.MAX_VALUE;
            const prevWidth = prevItem.width ?? Number.MAX_VALUE;
            const prevHeight = prevItem.height ?? Number.MAX_VALUE;
            return (curWidth * curHeight < prevWidth * prevHeight) ? curr : prev;
          }, imageItems[0]);
        }
        const [thumbnailItemId, thumbnailMetadata] = thumbnailItem || [];

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
            dataTableMetadata: dataTableMetadata as StoredObjectDataTableMetadata,
            dataTableItemId,
            thumbnailItemId,
            thumbnailMetadata,
          });
        }
      });
      setStoredObjectDataTables(newStoredObjectDataTables);
      setInitialized(true);
    });

    return () => {
      unsubscribe();
    };

  }, [objectStorageConfig, fatalError]);

  // get thumbnails as they are added
  useEffect(() => {
    const fetchThumbnails = async () => {
      if (!objectStorageRef.current) return;

      for (const obj of storedObjectDataTables) {
        // Only fetch if we have a thumbnail ID and haven't already fetched it
        if (obj.thumbnailItemId && !fetchedThumbnailIds.current.has(obj.objectId)) {
          fetchedThumbnailIds.current.add(obj.objectId);

          const imageData = await objectStorageRef.current.readDataItem(obj.objectId, obj.thumbnailItemId);
          if (imageData?.url) {
            setThumbnailUrls(prev => new Map(prev).set(obj.objectId, imageData.url));
          }
        }
      }
    };

    fetchThumbnails();
  }, [storedObjectDataTables]);

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

    // eslint-disable-next-line max-len
    const dataTableData = await objectStorageRef.current?.readDataItem(selectedDataTableObjectId, selectedDataTableObject.dataTableItemId);
    if (!dataTableData) {
      alert("The selected object does not contain a data table item.");
      return;
    }

    const { cols } = selectedDataTableObject.dataTableMetadata;
    const attrs: any[] = cols.map((col: any) => ({name: col, type: "numeric"}));
    attrs.push({ name: "__objectId", type: "categorical", hidden: true });

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
        name: selectedDataTableObject.name,
        __objectId: selectedDataTableObjectId
      };
      cols.forEach((col, index) => {
        item[col] = (rowValues as any)[index];
      });
      return item;
    });
    await createItems(kDataContextName, items);

    await createTable(kDataContextName);

    highlightDataSet(selectedDataTableObjectId);

    setImportedDataTableIds(prev => new Set(prev).add(selectedDataTableObjectId));

  }, [selectedDataTableObjectId, storedObjectDataTables, highlightDataSet]);

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
          {storedObjectDataTables.map(({objectId, name}) => {
            // eslint-disable-next-line max-len
            const className = `${selectedDataTableObjectId === objectId ? "selected" : ""} ${importedDataTableIds.has(objectId) ? "imported" : ""} dataset`;
            const thumbnailUrl = thumbnailUrls.get(objectId);

            return (
              <div
                key={objectId}
                className={className}
                onClick={() => handleSelectDataTableId(objectId)}
              >
                {thumbnailUrl && (
                  <span className="thumbnail"><img src={thumbnailUrl} alt={`Thumbnail for ${name}`} /></span>
                )}
                <span className="dataset-name">{name}</span>
              </div>
            );
          })}
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
