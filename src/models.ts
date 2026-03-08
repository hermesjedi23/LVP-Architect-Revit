
export interface Point {
  x: number;
  y: number;
}

export interface CustomCorridor {
  centerline: Point[];
  boundary1: Point[];
  boundary2: Point[];
  id: number;
}

export interface Wall {
  points: Point[];
  isClosed: boolean;
  id: number;
}

export interface SalesAreaRequest {
  id: number;
  name: string;
  brand: string;
  division: string;
  minArea: number;
  maxArea: number;
}

export interface DrawnSalesArea extends SalesAreaRequest {
  cells: Point[];
  points: Point[]; // Polygon vertices
  centroid: Point;
  actualAreaM2: number;
}

export interface Entrance {
  point: Point;
  id: number;
}

export interface AppState {
  points: Point[];
  isClosed: boolean;
  pixelsPerMeter: number;
  customCorridors: CustomCorridor[];
  nextCorridorId: number;
  walls: Wall[];
  nextWallId: number;
  salesAreaRequests: SalesAreaRequest[];
  drawnSalesAreas: DrawnSalesArea[];
  nextSalesAreaId: number;
  entrance: Entrance | null;
}

export type VertexSelection = {
  type: 'boundary' | 'custom_corridor_centerline' | 'wall' | 'sales_area';
  pointIndex: number;
  customCorridorId?: number;
  wallId?: number;
  salesAreaId?: number;
};
