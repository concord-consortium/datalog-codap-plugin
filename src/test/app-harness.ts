export const codapRequestStub = async (request: any) => {
  if (request.resource === "interactiveApi") {
    return {
      success: true,
      values: {
        available: true,
        initInteractive: {
          objectStorageConfig: { version: 1, type: "demo" },
          linkedInteractives: [{ id: "source", label: "data_source_interactive" }]
        }
      }
    };
  }
  return { success: true };
};

export const storageStub = (objects: any[], readDataItem: jest.Mock) => ({
  monitor: jest.fn(async (_interactiveId: string, callback: (stored: any[]) => void) => {
    callback(objects);
    return () => undefined;
  }),
  readDataItem
});
