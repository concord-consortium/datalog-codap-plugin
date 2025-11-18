
import React from "react";
import { makeRandomFromSeed } from "../utils/random";

const CELL_SIZE = 3;
const WIDTH = 100;
const HEIGHT = 100;
const COLS = Math.floor(WIDTH / CELL_SIZE);
const ROWS = Math.floor(HEIGHT / CELL_SIZE);

enum CELL_TYPES {
  EMPTY = 0,
  VEGETATION = 1,
  SHEEP = 2,
  WOLF = 3,
}

interface Cell {
  x: number;
  y: number;
  fill: string;
}

interface PredatorPreyPlaceholderProps {
  seed?: string;
}

const ScreenshotPlaceholder: React.FC<PredatorPreyPlaceholderProps> = ({
  seed = "default-seed",
}) => {
  const cells = React.useMemo<Cell[]>(() => {
    const rng = makeRandomFromSeed(seed);

    const cellList: Cell[] = [];
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const r = rng();
        let type: CELL_TYPES;

        if (r < 0.5) type = CELL_TYPES.EMPTY;
        else if (r < 0.8) type = CELL_TYPES.VEGETATION;
        else if (r < 0.95) type = CELL_TYPES.SHEEP;
        else type = CELL_TYPES.WOLF;

        if (type !== CELL_TYPES.EMPTY) {
          const x = col * CELL_SIZE;
          const y = row * CELL_SIZE;

          let fill: string;
          switch (type) {
            case CELL_TYPES.VEGETATION:
              fill = "#006400"; // dark green
              break;
            case CELL_TYPES.SHEEP:
              fill = "#ffffff"; // white
              break;
            case CELL_TYPES.WOLF:
              fill = "#8b4513"; // brown
              break;
            default:
              continue;
          }

          cellList.push({ x, y, fill });
        }
      }
    }
    return cellList;
  }, [seed]);

  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Light green background */}
      <rect x="0" y="0" width="100%" height="100%" fill="#c8f7c5" />

      {/* Cells */}
      {cells.map((cell, idx) => (
        <rect
          key={idx}
          x={cell.x}
          y={cell.y}
          width={CELL_SIZE}
          height={CELL_SIZE}
          fill={cell.fill}
        />
      ))}
    </svg>
  );
};

export default ScreenshotPlaceholder;
