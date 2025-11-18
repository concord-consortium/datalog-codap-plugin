import { DataSetRow, FakeDataSet } from "../types";
import { makeRandomFromSeed } from "./random";

export const generateFakeDataSets = (): FakeDataSet[] => ([
  { id: "1", name: "Fake Data Set 1", length: 2000, imported: false, data: generateFakeDataForSet("1", 2000) },
  { id: "2", name: "Fake Data Set 2", length: 5000, imported: false, data: generateFakeDataForSet("2", 5000) },
  { id: "3", name: "Fake Data Set 3", length: 3000, imported: false, data: generateFakeDataForSet("3", 3000) }
]);

export const generateFakeDataForSet = (id: string, length: number): DataSetRow[] => {
  const rand = makeRandomFromSeed(id);

  return Array.from({ length: Math.round(length / 10) }, (_, time) => ({
    time: time * 10,
    wolves: Math.round(rand() * 50),
    sheep: Math.round(rand() * 200),
    vegetation: Math.round(rand() * 100),
  })) as DataSetRow[];
};
