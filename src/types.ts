export interface DataSetRow {
  time: number;
  wolves: number;
  sheep: number;
  vegetation: number;
}

export interface FakeDataSet {
  id: string;
  name: string;
  length: number;
  imported: boolean;
  data: DataSetRow[];
};
