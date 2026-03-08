import { Component, ChangeDetectionStrategy, signal, computed, WritableSignal, Signal, inject, ViewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { polygonContains } from 'd3-polygon';
import * as XLSX from 'xlsx';
import { Point, CustomCorridor, Wall, SalesAreaRequest, DrawnSalesArea, AppState, VertexSelection, Entrance } from './models';
import { GeometryService } from './geometry.service';
import { ThreeViewer } from './three-viewer';
import { GoogleGenAI, Type } from "@google/genai";

declare const GEMINI_API_KEY: string;

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  imports: [CommonModule, MatIconModule, ThreeViewer],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements AfterViewInit, OnDestroy {
  private geometryService = inject(GeometryService);

  @ViewChild('svgContainer') svgContainer!: ElementRef<SVGSVGElement>;
  svgWidth = signal(0);
  svgHeight = signal(0);
  private resizeObserver: ResizeObserver | null = null;

  points: WritableSignal<Point[]> = signal([]);
  isClosed: WritableSignal<boolean> = signal(false);
  pixelsPerMeter: WritableSignal<number> = signal(20);
  
  // Unified selection and dragging state
  selectedVertex: WritableSignal<VertexSelection | null> = signal(null);
  draggedVertex: WritableSignal<VertexSelection | null> = signal(null);

  // Professional, architectural color palette
  private divisionColors = [
    '#475569', '#334155', '#1e293b', '#0f172a', // Slates
    '#52525b', '#3f3f46', '#27272a', '#18181b', // Zincs
    '#57534e', '#44403c', '#292524', '#1c1917', // Stones
    '#3f6212', '#365314', '#1a2e05', // Greens
    '#7c2d12', '#451a03', // Oranges
    '#7f1d1d', '#450a0a', // Reds
    '#1e3a8a', '#1e1b4b'  // Blues
  ];
  isDrawingCorridor = signal(false);
  currentCorridorPoints = signal<Point[]>([]);
  mousePosition = signal<Point | null>(null);
  customCorridors = signal<CustomCorridor[]>([]);
  private nextCorridorId = 0;

  // Sales Area state
  salesAreaRequests = signal<SalesAreaRequest[]>([]);
  drawnSalesAreas = signal<DrawnSalesArea[]>([]);
  isGeneratingAI = signal(false);
  rulesText = signal<string>('');
  showSalesAreas = signal(true);
  isEditingSalesAreas = signal(false);
  unitSystem = signal<'metric' | 'imperial'>('metric');
  csvImportUnit = signal<'metric' | 'imperial'>('metric');
  viewMode = signal<'2d' | '3d'>('2d');
  private nextSalesAreaId = 0;
  public readonly gridCellSize = 5; // Pixels. Used for sales area generation.

  // Wall state
  isDrawingWall = signal(false);
  currentWallPoints = signal<Point[]>([]);
  walls = signal<Wall[]>([]);
  entrance = signal<Entrance | null>(null);
  isSettingEntrance = signal(false);
  private nextWallId = 0;

  // History state
  private history: AppState[] = [];
  private historyPointer = -1;
  private isRestoringState = false;
  canUndo = signal(false);
  canRedo = signal(false);

  // Zoom and Pan state
  zoom = signal(1);
  pan = signal({ x: 0, y: 0 });
  isPanning = signal(false);
  private lastPanPoint: Point | null = null;
  private hasMovedDuringMouseDown = false;

  // Computed signal to generate the string for SVG polyline/polygon points attribute
  svgPoints: Signal<string> = computed(() => {
    return this.getPolygonPoints(this.points());
  });

  corridorPreviewLength = computed(() => {
    const pts = this.currentCorridorPoints();
    const mouse = this.mousePosition();
    if (pts.length === 1 && mouse) {
      const p1 = pts[0];
      const dist = Math.sqrt(Math.pow(mouse.x - p1.x, 2) + Math.pow(mouse.y - p1.y, 2));
      return dist / this.pixelsPerMeter();
    }
    return 0;
  });
  
  selectedVertexData = computed(() => {
    const selection = this.selectedVertex();
    if (!selection) return null;

    let point: Point | undefined;
    let name: string = '';

    if (selection.type === 'boundary') {
      point = this.points()[selection.pointIndex];
      name = `Vertex #${selection.pointIndex}`;
    } else if (selection.type === 'custom_corridor_centerline' && typeof selection.customCorridorId !== 'undefined') {
      const corridor = this.customCorridors().find(c => c.id === selection.customCorridorId);
      if (corridor) {
        point = corridor.centerline[selection.pointIndex];
        const corridorDisplayIndex = this.customCorridors().findIndex(c => c.id === selection.customCorridorId) + 1;
        name = `Manual Corridor ${corridorDisplayIndex} / Vertex #${selection.pointIndex}`;
      }
    } else if (selection.type === 'sales_area' && typeof selection.salesAreaId !== 'undefined') {
      const area = this.drawnSalesAreas().find(a => a.id === selection.salesAreaId);
      if (area) {
        point = area.points[selection.pointIndex];
        name = `${area.name} / Vertex #${selection.pointIndex}`;
      }
    } else if (selection.type === 'wall' && typeof selection.wallId !== 'undefined') {
      const wall = this.walls().find(w => w.id === selection.wallId);
      if (wall) {
        point = wall.points[selection.pointIndex];
        name = `Wall / Vertex #${selection.pointIndex}`;
      }
    }

    if (!point) return null;
    return { ...selection, point, name };
  });

  // Computed signal to determine if the "Close Polygon" button should be enabled
  canClose: Signal<boolean> = computed(() => this.points().length >= 3 && !this.isClosed());

  // Computed signal to determine if the "Clear" button should be enabled
  canClear: Signal<boolean> = computed(() => this.points().length > 0 || this.customCorridors().length > 0 || this.salesAreaRequests().length > 0 || this.drawnSalesAreas().length > 0);

  // Computed signal to calculate the area of the polygon in square meters
  polygonArea: Signal<number> = computed(() => {
    return this.geometryService.calculateArea(this.points(), this.pixelsPerMeter());
  });

  // Computed signal to calculate lengths and midpoints of each line segment
  lineSegments: Signal<{ p1: Point; p2: Point; midpoint: Point; length: number }[]> = computed(() => {
    return this.geometryService.calculateSegments(this.points(), this.isClosed(), this.pixelsPerMeter());
  });
  
  // --- Division colors and legend computed signals ---
  divisions = computed(() => {
      const allDivisions = this.salesAreaRequests().map(area => area.division);
      return [...new Set(allDivisions)].sort();
  });

  layoutBounds = computed(() => {
    const pts = this.points();
    if (pts.length === 0) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(p => {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    });
    return { minX, minY, maxX, maxY };
  });

  unitLabel = computed(() => this.unitSystem() === 'metric' ? 'm' : 'ft');
  sqUnitLabel = computed(() => this.unitSystem() === 'metric' ? 'm²' : 'sq ft');

  divisionColorMap = computed(() => {
      const map = new Map<string, string>();
      this.divisions().forEach((division, index) => {
          map.set(division, this.divisionColors[index % this.divisionColors.length]);
      });
      return map;
  });

  toggleUnitSystem(): void {
    this.unitSystem.update(u => u === 'metric' ? 'imperial' : 'metric');
  }

  formatArea(m2: number): string {
    const value = this.unitSystem() === 'metric' ? m2 : m2 * 10.7639;
    return `${value.toFixed(1)} ${this.sqUnitLabel()}`;
  }

  formatCoordinate(pixels: number): string {
    const meters = pixels / this.pixelsPerMeter();
    const value = this.unitSystem() === 'metric' ? meters : meters * 3.28084;
    return `${value.toFixed(2)} ${this.unitLabel()}`;
  }

  getDraggedSalesArea(): DrawnSalesArea | undefined {
    const selection = this.draggedVertex();
    if (selection?.type === 'sales_area' && typeof selection.salesAreaId !== 'undefined') {
      return this.drawnSalesAreas().find(a => a.id === selection.salesAreaId);
    }
    return undefined;
  }

  constructor() {
    this.saveState(); // Save initial empty state
  }

  ngAfterViewInit(): void {
    this.resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        this.svgWidth.set(entry.contentRect.width);
        this.svgHeight.set(entry.contentRect.height);
      }
    });
    if (this.svgContainer) {
      this.resizeObserver.observe(this.svgContainer.nativeElement);
    }
  }

  ngOnDestroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
  }

  getPolygonPoints(points: Point[]): string {
    return points.map(p => `${p.x},${p.y}`).join(' ');
  }

  handleCanvasClick(event: MouseEvent): void {
    // Prevent click action if we were panning
    if (this.hasMovedDuringMouseDown) {
      this.hasMovedDuringMouseDown = false;
      return;
    }

    const svg = event.currentTarget as SVGSVGElement;
    const { x, y } = this.getTransformedPoint(event.clientX, event.clientY, svg);

    if (this.isSettingEntrance()) {
        const svg = event.currentTarget as SVGSVGElement;
        const { x, y } = this.getTransformedPoint(event.clientX, event.clientY, svg);
        this.entrance.set({ point: { x, y }, id: Date.now() });
        this.isSettingEntrance.set(false);
        this.saveState();
        return;
    }

    if (this.isDrawingCorridor()) {
        const pts = this.currentCorridorPoints();
        if (pts.length === 0) {
            this.currentCorridorPoints.set([{x, y}]);
        } else {
            this.currentCorridorPoints.update(p => [...p, {x, y}]);
            this.finishCorridor();
        }
        return; 
    }

    if (this.isDrawingWall()) {
        this.currentWallPoints.update(p => [...p, {x, y}]);
        return;
    }

    // If clicking on the canvas, deselect any selected point.
    this.selectedVertex.set(null);

    if (this.isClosed()) {
      return;
    }
    
    this.points.update(currentPoints => [...currentPoints, { x, y }]);
    this.saveState();
  }

  closePolygon(): void {
    if (this.canClose()) {
      this.isClosed.set(true);
      this.saveState();
    }
  }

  clear(): void {
    this.points.set([]);
    this.isClosed.set(false);
    this.customCorridors.set([]);
    this.currentCorridorPoints.set([]);
    this.isDrawingCorridor.set(false);
    this.walls.set([]);
    this.entrance.set(null);
    this.currentWallPoints.set([]);
    this.isDrawingWall.set(false);
    this.selectedVertex.set(null);
    this.draggedVertex.set(null);
    this.nextCorridorId = 0;
    this.salesAreaRequests.set([]);
    this.drawnSalesAreas.set([]);
    this.nextSalesAreaId = 0;
    this.saveState();
  }
  
  updateScale(event: Event): void {
    const input = event.target as HTMLInputElement;
    const value = input.valueAsNumber;
    if (!isNaN(value) && value > 0) {
      const pixelsPerMeter = this.unitSystem() === 'metric' ? value : value * 3.28084;
      this.pixelsPerMeter.set(pixelsPerMeter);
      this.saveState();
    }
  }
  
  selectVertex(event: MouseEvent, type: 'boundary' | 'custom_corridor_centerline' | 'wall' | 'sales_area', pointIndex: number, customCorridorId?: number, wallId?: number, salesAreaId?: number): void {
    event.stopPropagation();
    const newSelection: VertexSelection = { type, pointIndex, customCorridorId, wallId, salesAreaId };
    const currentSelection = this.selectedVertex();

    // Toggle selection
    if (
        currentSelection?.pointIndex === newSelection.pointIndex &&
        currentSelection.customCorridorId === newSelection.customCorridorId &&
        currentSelection.wallId === newSelection.wallId &&
        currentSelection.salesAreaId === newSelection.salesAreaId &&
        currentSelection.type === newSelection.type
    ) {
        this.selectedVertex.set(null);
    } else {
        this.selectedVertex.set(newSelection);
    }
  }

  updateVertexCoordinate(axis: 'x' | 'y', event: Event): void {
    const selection = this.selectedVertex();
    if (!selection) return;

    const input = event.target as HTMLInputElement;
    const value = input.valueAsNumber;
    if (isNaN(value)) return;

    // Convert Cartesian Y back to SVG Y for storage
    const storedValue = axis === 'y' ? -value : value;

    if (selection.type === 'boundary') {
      this.points.update(currentPoints => {
        const newPoints = [...currentPoints];
        if (newPoints[selection.pointIndex]) {
          const pointToUpdate = { ...newPoints[selection.pointIndex] };
          pointToUpdate[axis] = storedValue;
          newPoints[selection.pointIndex] = pointToUpdate;
        }
        return newPoints;
      });
    } else if (selection.type === 'custom_corridor_centerline' && typeof selection.customCorridorId !== 'undefined') {
        const corridor = this.customCorridors().find(c => c.id === selection.customCorridorId!);
        if (corridor && corridor.centerline[selection.pointIndex]) {
            const currentPoint = corridor.centerline[selection.pointIndex];
            const newPoint = { ...currentPoint, [axis]: storedValue };
            this.updateCustomCorridorPoint(selection.customCorridorId, selection.pointIndex, newPoint);
        }
    } else if (selection.type === 'wall' && typeof selection.wallId !== 'undefined') {
        this.walls.update(walls => {
            const newWalls = [...walls];
            const wallIndex = newWalls.findIndex(w => w.id === selection.wallId);
            if (wallIndex !== -1) {
                const newPoints = [...newWalls[wallIndex].points];
                newPoints[selection.pointIndex] = { ...newPoints[selection.pointIndex], [axis]: storedValue };
                newWalls[wallIndex] = { ...newWalls[wallIndex], points: newPoints };
            }
            return newWalls;
        });
    } else if (selection.type === 'sales_area' && typeof selection.salesAreaId !== 'undefined') {
        this.drawnSalesAreas.update(areas => {
            const newAreas = [...areas];
            const areaIndex = newAreas.findIndex(a => a.id === selection.salesAreaId);
            if (areaIndex !== -1) {
                const newPoints = [...newAreas[areaIndex].points];
                newPoints[selection.pointIndex] = { ...newPoints[selection.pointIndex], [axis]: storedValue };
                newAreas[areaIndex] = { ...newAreas[areaIndex], points: newPoints };
                // Recalculate area and centroid
                newAreas[areaIndex].actualAreaM2 = this.geometryService.calculateArea(newAreas[areaIndex].points, this.pixelsPerMeter());
                newAreas[areaIndex].centroid = this.calculateCentroid(newAreas[areaIndex].points);
            }
            return newAreas;
        });
    }
  }

  startDrag(event: MouseEvent, type: 'boundary' | 'custom_corridor_centerline' | 'wall' | 'sales_area', pointIndex: number, customCorridorId?: number, wallId?: number, salesAreaId?: number): void {
    event.stopPropagation();
    this.draggedVertex.set({ type, pointIndex, customCorridorId, wallId, salesAreaId });
  }

  handleMouseMove(event: MouseEvent): void {
    const svg = event.currentTarget as SVGSVGElement;
    const { x, y } = this.getTransformedPoint(event.clientX, event.clientY, svg);
    this.mousePosition.set({ x, y });

    if (this.isPanning() && this.lastPanPoint) {
      const dx = event.clientX - this.lastPanPoint.x;
      const dy = event.clientY - this.lastPanPoint.y;
      
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        this.hasMovedDuringMouseDown = true;
      }

      this.pan.update(p => ({ x: p.x + dx, y: p.y + dy }));
      this.lastPanPoint = { x: event.clientX, y: event.clientY };
      return;
    }

    if (this.draggedVertex()) {
      this.dragVertex(event);
    }
  }

  handleMouseDown(event: MouseEvent): void {
    if (event.button === 0 && !this.isDrawingCorridor() && !this.draggedVertex()) {
      // Only pan if we didn't click on a vertex (which would have stopped propagation)
      this.isPanning.set(true);
      this.lastPanPoint = { x: event.clientX, y: event.clientY };
      this.hasMovedDuringMouseDown = false;
    }
  }

  handleMouseUp(): void {
    this.isPanning.set(false);
    this.lastPanPoint = null;
    this.endDragAll();
  }

  handleWheel(event: WheelEvent): void {
    event.preventDefault();
    const svg = event.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const mouseX = event.clientX - rect.left - centerX;
    const mouseY = event.clientY - rect.top - centerY;

    const zoomFactor = 1.1;
    const delta = event.deltaY;
    const oldZoom = this.zoom();
    const newZoom = delta > 0 ? oldZoom / zoomFactor : oldZoom * zoomFactor;
    const clampedZoom = Math.max(0.1, Math.min(20, newZoom));

    const oldPan = this.pan();
    const newPanX = mouseX - (mouseX - oldPan.x) * (clampedZoom / oldZoom);
    const newPanY = mouseY - (mouseY - oldPan.y) * (clampedZoom / oldZoom);

    this.zoom.set(clampedZoom);
    this.pan.set({ x: newPanX, y: newPanY });
  }

  resetZoom(): void {
    this.zoom.set(1);
    this.pan.set({ x: 0, y: 0 });
  }

  private getTransformedPoint(clientX: number, clientY: number, svg: SVGSVGElement): Point {
    const rect = svg.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const x = (clientX - rect.left - centerX - this.pan().x) / this.zoom();
    const y = (clientY - rect.top - centerY - this.pan().y) / this.zoom();
    return { x, y };
  }

  private dragVertex(event: MouseEvent): void {
    const selection = this.draggedVertex();
    if (!selection) return;
    
    const svg = event.currentTarget as SVGSVGElement;
    const { x, y } = this.getTransformedPoint(event.clientX, event.clientY, svg);

    if (selection.type === 'boundary') {
      this.points.update(currentPoints => {
        const newPoints = [...currentPoints];
        newPoints[selection.pointIndex] = { x, y };
        return newPoints;
      });
    } else if (selection.type === 'custom_corridor_centerline' && typeof selection.customCorridorId !== 'undefined') {
      this.updateCustomCorridorPoint(selection.customCorridorId, selection.pointIndex, { x, y });
    } else if (selection.type === 'wall' && typeof selection.wallId !== 'undefined') {
        this.walls.update(walls => {
            const newWalls = [...walls];
            const wallIndex = newWalls.findIndex(w => w.id === selection.wallId);
            if (wallIndex !== -1) {
                const newPoints = [...newWalls[wallIndex].points];
                newPoints[selection.pointIndex] = { x, y };
                newWalls[wallIndex] = { ...newWalls[wallIndex], points: newPoints };
            }
            return newWalls;
        });
    } else if (selection.type === 'sales_area' && typeof selection.salesAreaId !== 'undefined') {
        this.drawnSalesAreas.update(areas => {
            const newAreas = [...areas];
            const areaIndex = newAreas.findIndex(a => a.id === selection.salesAreaId);
            if (areaIndex !== -1) {
                const newPoints = [...newAreas[areaIndex].points];
                newPoints[selection.pointIndex] = { x, y };
                newAreas[areaIndex] = { ...newAreas[areaIndex], points: newPoints };
                // Recalculate area and centroid
                newAreas[areaIndex].actualAreaM2 = this.geometryService.calculateArea(newAreas[areaIndex].points, this.pixelsPerMeter());
                newAreas[areaIndex].centroid = this.calculateCentroid(newAreas[areaIndex].points);
            }
            return newAreas;
        });
    }
  }

  endDragAll(): void {
    if (this.draggedVertex() !== null) {
      this.draggedVertex.set(null);
      this.saveState();
    }
  }
  
  onSalesAreaFileSelected(event: Event): void {
    this.handleFile(event, this.parseSalesAreaCsv.bind(this));
  }

  onRulesFileSelected(event: Event): void {
    this.handleFile(event, (text) => {
      this.rulesText.set(text);
      alert("Rules loaded successfully!");
    });
  }

  onPolygonFileSelected(event: Event): void {
    this.handleFile(event, this.parsePolygonCsv.bind(this));
  }

  toggleSalesAreaVisibility(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.showSalesAreas.set(input.checked);
  }

  private parsePolygonCsv(csvText: string): void {
    const newPoints: Point[] = [];
    const rows = csvText.split(/\r?\n/).filter(row => row.trim() !== '');
    
    // Determine pixels per unit based on selected import unit
    const isMetric = this.csvImportUnit() === 'metric';
    const pixelsPerUnit = isMetric ? this.pixelsPerMeter() : (this.pixelsPerMeter() / 3.28084);

    try {
      for (let i = 0; i < rows.length; i++) {
        const columns = rows[i].split(',').map(c => c.trim());
        if (columns.length < 2) continue;

        const x = parseFloat(columns[0]);
        const y = parseFloat(columns[1]);
        // columns[2] is Z, which we ignore for 2D points but could use if needed

        if (isNaN(x) || isNaN(y)) {
          // If the first row is not numeric, it might be a header
          if (i === 0) continue;
          console.warn(`Skipping row ${i + 1} in polygon CSV due to invalid coordinates.`);
          continue;
        }

        // Scale from units (m or ft) to pixels
        // Invert Y to match Cartesian (Y-up) to SVG (Y-down)
        newPoints.push({ 
          x: x * pixelsPerUnit, 
          y: -y * pixelsPerUnit 
        });
      }

      if (newPoints.length >= 3) {
        this.points.set(newPoints);
        this.isClosed.set(true); // Automatically close if loaded from file
        this.saveState();
      } else if (newPoints.length > 0) {
        this.points.set(newPoints);
        this.isClosed.set(false);
        this.saveState();
      }
    } catch (error) {
      console.error("Error parsing polygon CSV file:", error);
    }
  }

  private parseSalesAreaCsv(csvText: string): void {
    const newRequests: SalesAreaRequest[] = [];
    const rows = csvText.split(/\r?\n/).filter(row => row.trim() !== '');
    if (rows.length < 2) {
      console.error("Sales area CSV needs a header and at least one data row.");
      return;
    }

    const headerRow = rows[0].replace(/^\uFEFF/, ''); // Remove BOM
    const header = headerRow.split(',').map(h => h.trim().replace(/\s+/g, '').toLowerCase());
    
    const nameIndex = header.indexOf('nombresección');
    const brandIndex = header.indexOf('marca');
    const divisionIndex = header.indexOf('nombredivisión');
    const minAreaIndex = header.indexOf('minimos');
    const maxAreaIndex = header.indexOf('maximos');

    const required = {
        'nombresección': 'Nombre Sección',
        'nombredivisión': 'Nombre División',
        'minimos': 'Minimos',
        'maximos': 'Maximos'
    };

    const missing = Object.keys(required).filter(key => header.indexOf(key) === -1).map(key => `'${required[key as keyof typeof required]}'`);

    if (missing.length > 0) {
      console.error(`Sales Area CSV header is missing required columns: ${missing.join(', ')}. Found headers: ${rows[0]}`);
      return;
    }
    
    try {
      for (let i = 1; i < rows.length; i++) {
        const columns = rows[i].split(',').map(c => c.trim());
        if (columns.length < header.length) continue;

        const name = columns[nameIndex];
        const brand = brandIndex > -1 ? columns[brandIndex] : 'Default';
        const division = columns[divisionIndex];
        const minArea = parseFloat(columns[minAreaIndex]);
        const maxArea = parseFloat(columns[maxAreaIndex]);

        if (!name || !division || [minArea, maxArea].some(isNaN) || minArea === 0 || maxArea === 0) {
          console.warn(`Skipping row ${i+1} in sales area CSV due to missing values, invalid areas, or zero area.`);
          continue;
        }
        
        newRequests.push({
          id: this.nextSalesAreaId++,
          name,
          brand,
          division,
          minArea,
          maxArea,
        });
      }

      if (newRequests.length > 0) {
        this.salesAreaRequests.set(newRequests);
        this.drawnSalesAreas.set([]); // Clear previously drawn areas
        this.saveState();
      }
    } catch (error) {
      console.error("Error parsing sales area CSV file:", error);
    }
  }

  private handleFile(event: Event, parser: (text: string) => void): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) {
      return;
    }

    const file = input.files[0];
    const reader = new FileReader();

    reader.onload = (e: ProgressEvent<FileReader>) => {
      const text = e.target?.result as string;
      if (text) {
        parser(text);
      }
    };

    reader.onerror = () => {
        console.error("Error reading the file.");
    };

    reader.readAsText(file);
    
    input.value = '';
  }
  
  private calculateCentroid(points: Point[]): Point {
    if (points.length === 0) return { x: 0, y: 0 };
    const sumX = points.reduce((sum, p) => sum + p.x, 0);
    const sumY = points.reduce((sum, p) => sum + p.y, 0);
    return { x: sumX / points.length, y: sumY / points.length };
  }

  private getBounds(cells: Point[]): { minX: number, minY: number, maxX: number, maxY: number } {
    if (cells.length === 0) {
        return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of cells) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    }
    return { minX, minY, maxX, maxY };
  }

  // --- Automatic Sales Area Drawing ---
  drawSalesAreas(): void {
    const outerBoundary = this.points();
    const customCorridors = this.customCorridors();
    const scale = this.pixelsPerMeter();

    if (!this.isClosed() || outerBoundary.length < 3 || this.salesAreaRequests().length === 0) {
      console.warn("Cannot draw sales areas. Ensure a boundary is closed and sales area data is loaded.");
      return;
    }

    const worldBounds = this.getBounds(outerBoundary);
    const cellAreaM2 = (this.gridCellSize / scale) * (this.gridCellSize / scale);

    const minXCell = Math.floor(worldBounds.minX / this.gridCellSize);
    const minYCell = Math.floor(worldBounds.minY / this.gridCellSize);
    const maxXCell = Math.ceil(worldBounds.maxX / this.gridCellSize);
    const maxYCell = Math.ceil(worldBounds.maxY / this.gridCellSize);

    const rows = maxYCell - minYCell + 1;
    const cols = maxXCell - minXCell + 1;

    type GridCell = { state: 'valid' | 'invalid' | 'taken'; division: string | null; inCorridor: boolean; x: number; y: number; };
    const grid: GridCell[][] = [];
    
    const outerBoundaryTuple = outerBoundary.map(p => [p.x, p.y] as [number, number]);
    const corridorPolygons = customCorridors.map(corridor => {
      const polygonPoints = [...corridor.boundary1, ...[...corridor.boundary2].reverse()];
      return polygonPoints.map(p => [p.x, p.y] as [number, number]);
    });
    const wallPolygons = this.walls().map(wall => {
      return wall.points.map(p => [p.x, p.y] as [number, number]);
    });

    const validCells: Point[] = [];

    for (let r = 0; r < rows; r++) {
      grid[r] = [];
      for (let c = 0; c < cols; c++) {
        const gridX = minXCell + c;
        const gridY = minYCell + r;
        const cellCenter: [number, number] = [
          gridX * this.gridCellSize + this.gridCellSize / 2, 
          gridY * this.gridCellSize + this.gridCellSize / 2
        ];
        
        const inCorridor = corridorPolygons.some(corridorPoly => polygonContains(corridorPoly, cellCenter));
        const inWall = wallPolygons.some(wallPoly => polygonContains(wallPoly, cellCenter));
        const inOuterBoundary = polygonContains(outerBoundaryTuple, cellCenter);
        const isValid = inOuterBoundary && !inCorridor && !inWall;
        
        grid[r][c] = {
          state: isValid ? 'valid' : 'invalid',
          division: null,
          inCorridor: inCorridor,
          x: gridX,
          y: gridY
        };

        if (isValid) {
          validCells.push({ x: c, y: r });
        }
      }
    }
    
    if (validCells.length === 0) {
      console.warn("No valid cells found inside boundary for sales areas.");
      return;
    }

    const requestsByDivision = new Map<string, SalesAreaRequest[]>();
    for (const req of this.salesAreaRequests()) {
        if (!requestsByDivision.has(req.division)) {
            requestsByDivision.set(req.division, []);
        }
        requestsByDivision.get(req.division)!.push(req);
    }
    
    const divisionJobs = Array.from(requestsByDivision.entries()).map(([division, requests]) => ({
        division,
        requests: requests.sort((a, b) => b.maxArea - a.maxArea),
        totalMaxArea: requests.reduce((sum, r) => sum + r.maxArea, 0),
    })).sort((a, b) => b.totalMaxArea - a.totalMaxArea);

    let corridorAdjacentCells = this.getCorridorAdjacentCells(grid);
    
    // Fallback: if no corridors, use all valid cells as potential seeds
    if (corridorAdjacentCells.length === 0) {
      corridorAdjacentCells = [...validCells];
    }

    const newDrawnAreas: DrawnSalesArea[] = [];
    const globalTakenCells = new Set<string>();

    for (const job of divisionJobs) {
        const currentDivisionCells = new Set<string>();

        for (const request of job.requests) {
            const targetCellsCount = Math.ceil(request.minArea / cellAreaM2);
            
            let bestPlacement: Point[] | null = null;
            let bestScore = -1;

            const side = Math.sqrt(targetCellsCount);
            const aspectRatios = [1, 1.5, 0.66, 2, 0.5];
            
            let potentialSeeds: Point[] = [];
            if (currentDivisionCells.size > 0) {
                const adjToDivision = new Set<string>();
                for (const cellStr of currentDivisionCells) {
                    const [cx, cy] = cellStr.split(',').map(Number);
                    const neighbors = [{x:cx,y:cy-1}, {x:cx+1,y:cy}, {x:cx,y:cy+1}, {x:cx-1,y:cy}];
                    for (const n of neighbors) {
                        const key = `${n.x},${n.y}`;
                        if (grid[n.y]?.[n.x]?.state === 'valid' && !globalTakenCells.has(key)) {
                            adjToDivision.add(key);
                        }
                    }
                }
                potentialSeeds = Array.from(adjToDivision).map(key => {
                    const [x, y] = key.split(',').map(Number);
                    return {x, y};
                });
                potentialSeeds.push(...corridorAdjacentCells.filter(s => !globalTakenCells.has(`${s.x},${s.y}`)));
            } else {
                potentialSeeds = corridorAdjacentCells.filter(s => !globalTakenCells.has(`${s.x},${s.y}`));
            }

            for (const ratio of aspectRatios) {
                const w = Math.max(1, Math.round(side * Math.sqrt(ratio)));
                const h = Math.max(1, Math.round(targetCellsCount / w));
                
                for (const seed of potentialSeeds) {
                    for (let ox = -w + 1; ox <= 0; ox++) {
                        for (let oy = -h + 1; oy <= 0; oy++) {
                            const startX = seed.x + ox;
                            const startY = seed.y + oy;
                            
                            const currentPlacement: Point[] = [];
                            let valid = true;
                            let corridorContact = customCorridors.length === 0; // If no corridors, ignore contact requirement
                            let divisionContact = currentDivisionCells.size === 0; 

                            for (let rx = 0; rx < w; rx++) {
                                for (let ry = 0; ry < h; ry++) {
                                    const tx = startX + rx;
                                    const ty = startY + ry;
                                    const key = `${tx},${ty}`;

                                    if (grid[ty]?.[tx]?.state !== 'valid' || globalTakenCells.has(key)) {
                                        valid = false;
                                        break;
                                    }
                                    currentPlacement.push({x: tx, y: ty});
                                    
                                    if (!corridorContact) {
                                        const neighbors = [{x:tx,y:ty-1}, {x:tx+1,y:ty}, {x:tx,y:ty+1}, {x:tx-1,y:ty}];
                                        if (neighbors.some(n => grid[n.y]?.[n.x]?.inCorridor)) {
                                            corridorContact = true;
                                        }
                                    }
                                    if (!divisionContact) {
                                        const neighbors = [{x:tx,y:ty-1}, {x:tx+1,y:ty}, {x:tx,y:ty+1}, {x:tx-1,y:ty}];
                                        if (neighbors.some(n => currentDivisionCells.has(`${n.x},${n.y}`))) {
                                            divisionContact = true;
                                        }
                                    }
                                }
                                if (!valid) break;
                            }

                            if (valid && (corridorContact || divisionContact)) {
                                let score = 100;
                                if (corridorContact) score += 50;
                                if (divisionContact && currentDivisionCells.size > 0) score += 100;
                                
                                if (score > bestScore) {
                                    bestScore = score;
                                    bestPlacement = [...currentPlacement];
                                }
                            }
                        }
                        if (bestPlacement && ratio === 1) break;
                    }
                    if (bestPlacement && ratio === 1) break;
                }
                if (bestPlacement) break;
            }

            if (!bestPlacement) {
                for (const seed of potentialSeeds) {
                    if (grid[seed.y]?.[seed.x]?.state === 'valid' && !globalTakenCells.has(`${seed.x},${seed.y}`)) {
                        const potential = this.growAreaFromSeedBFS(
                            grid,
                            seed,
                            { minArea: request.minArea, maxArea: request.maxArea },
                            cellAreaM2
                        );
                        if (potential && potential.every(c => !globalTakenCells.has(`${c.x},${c.y}`))) {
                            bestPlacement = potential;
                            break;
                        }
                    }
                }
            }

            if (bestPlacement) {
                for (const cell of bestPlacement) {
                    const key = `${cell.x},${cell.y}`;
                    grid[cell.y][cell.x].state = 'taken';
                    globalTakenCells.add(key);
                    currentDivisionCells.add(key);
                }
                const actualAreaM2 = bestPlacement.length * cellAreaM2;
                
                // Map grid indices back to world coordinates
                const worldPlacement = bestPlacement.map(c => ({
                  x: grid[c.y][c.x].x,
                  y: grid[c.y][c.x].y
                }));

                const centroid = {
                    x: (worldPlacement.reduce((sum, c) => sum + c.x, 0) / worldPlacement.length) * this.gridCellSize + this.gridCellSize / 2,
                    y: (worldPlacement.reduce((sum, c) => sum + c.y, 0) / worldPlacement.length) * this.gridCellSize + this.gridCellSize / 2,
                };
                const boundaryPoints = this.getAreaBoundaryPoints(worldPlacement).map(p => ({
                    x: p.x * this.gridCellSize,
                    y: p.y * this.gridCellSize
                }));
                newDrawnAreas.push({ ...request, cells: bestPlacement, points: boundaryPoints, centroid, actualAreaM2 });
            } else {
                console.warn(`Could not place area ${request.name} of division ${job.division}.`);
            }
        }
    }

    this.drawnSalesAreas.set(newDrawnAreas);
    this.saveState();
  }

  private growAreaFromSeedBFS(
    grid: { state: string }[][],
    startCell: Point,
    areaRequest: { minArea: number, maxArea: number },
    cellAreaM2: number
  ): {x: number, y: number}[] | null {
    const queue: {p: Point, dist: number}[] = [{p: startCell, dist: 0}];
    const visited = new Set<string>([`${startCell.x},${startCell.y}`]);
    const collectedCells: { x: number; y: number }[] = [];

    while(queue.length > 0 && (collectedCells.length * cellAreaM2) < areaRequest.maxArea) {
      // Sort by Chebyshev distance to keep growth square-ish
      queue.sort((a, b) => a.dist - b.dist);
      const {p: current} = queue.shift()!;
      
      if (grid[current.y]?.[current.x]?.state !== 'valid') continue;
      
      collectedCells.push(current);
      
      const neighbors = [
        {x:current.x,y:current.y-1},{x:current.x+1,y:current.y},{x:current.x,y:current.y+1},{x:current.x-1,y:current.y},
        {x:current.x-1,y:current.y-1},{x:current.x+1,y:current.y-1},{x:current.x-1,y:current.y+1},{x:current.x+1,y:current.y+1}
      ];

      for (const n of neighbors) {
        const key = `${n.x},${n.y}`;
        if (!visited.has(key) && grid[n.y]?.[n.x]?.state === 'valid') {
          visited.add(key);
          const d = Math.max(Math.abs(n.x - startCell.x), Math.abs(n.y - startCell.y));
          queue.push({p: n, dist: d});
        }
      }
    }

    if (collectedCells.length * cellAreaM2 >= areaRequest.minArea) {
        return collectedCells;
    }

    return null;
  }

  private getCorridorAdjacentCells(grid: { inCorridor: boolean; state: string }[][]): Point[] {
    const adjacentCells: Point[] = [];
    for (let y = 0; y < grid.length; y++) {
        for (let x = 0; x < (grid[y]?.length || 0); x++) {
            if (grid[y][x].state === 'valid') {
                const neighbors = [{x:x, y:y-1}, {x:x+1, y:y}, {x:x, y:y+1}, {x:x-1, y:y}];
                for (const n of neighbors) {
                    if (grid[n.y]?.[n.x]?.inCorridor) {
                        adjacentCells.push({x, y});
                        break;
                    }
                }
            }
        }
    }
    return adjacentCells;
  }

  // --- Wall Drawing ---
  toggleWallDrawingMode(): void {
    const active = this.isDrawingWall();
    if (active) {
      this.finishWall();
    } else {
      this.isDrawingWall.set(true);
      this.currentWallPoints.set([]);
      this.selectedVertex.set(null);
      this.isDrawingCorridor.set(false);
    }
  }

  finishWall(): void {
    const pts = this.currentWallPoints();
    if (pts.length >= 3) {
      this.walls.update(w => [...w, {
        points: pts,
        isClosed: true,
        id: this.nextWallId++
      }]);
    }
    this.currentWallPoints.set([]);
    this.isDrawingWall.set(false);
    this.saveState();
  }

  cancelWall(): void {
    this.currentWallPoints.set([]);
    this.isDrawingWall.set(false);
  }

  // --- Manual Corridor Drawing ---
  toggleCorridorDrawingMode(): void {
    const active = this.isDrawingCorridor();
    if (active) {
      this.isDrawingCorridor.set(false);
      this.currentCorridorPoints.set([]);
    } else {
      this.isDrawingCorridor.set(true);
      this.selectedVertex.set(null);
    }
  }

  finishCorridor(): void {
    const points = this.currentCorridorPoints();
    if (points.length >= 2) {
      const widthInPixels = 2 * this.pixelsPerMeter();
      const { boundary1, boundary2 } = this.geometryService.generateCorridorBoundaries(points, widthInPixels);
      
      this.customCorridors.update(corridors => [
        ...corridors,
        {
          centerline: points,
          boundary1,
          boundary2,
          id: this.nextCorridorId++,
        }
      ]);
    }
    this.currentCorridorPoints.set([]);
    // Keep isDrawingCorridor as true to allow drawing multiple corridors
    this.saveState();
  }

  cancelCorridor(): void {
    this.currentCorridorPoints.set([]);
    this.isDrawingCorridor.set(false);
  }

  // --- AI Proposal ---
  async generateAIProposal(): Promise<void> {
    if (!this.isClosed() || this.points().length < 3 || this.salesAreaRequests().length === 0) {
      alert("Please ensure a boundary is closed and sales area data is loaded.");
      return;
    }

    this.isGeneratingAI.set(true);
    try {
      const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
      const model = "gemini-3.1-pro-preview";

      const boundary = this.points();
      const corridors = this.customCorridors();
      const walls = this.walls();
      const entrance = this.entrance();
      const requests = this.salesAreaRequests();
      const scale = this.pixelsPerMeter();

      const prompt = `
        You are an expert retail space planner. Your task is to propose a layout for a retail space.
        
        INPUT DATA:
        - Boundary (vertices in pixels): ${JSON.stringify(boundary)}
        - Existing Corridors: ${JSON.stringify(corridors)}
        - Existing Walls: ${JSON.stringify(walls)}
        - Store Entrance: ${JSON.stringify(entrance)}
        - Sales Area Requests: ${JSON.stringify(requests)}
        - Scale: ${scale} pixels per meter.
        
        ${this.rulesText() ? `ADDITIONAL RULES FROM FILE:\n${this.rulesText()}` : 'GENERAL RULES:'}
        1. All areas must be inside the boundary.
        2. Areas must not overlap with corridors or walls. THIS IS CRITICAL.
        3. Areas should be grouped by division where possible (Spatial Relationship: Adjacency by Division).
        4. Respect the minArea and maxArea (in m²) for each request.
        5. Propose a polygon (list of vertices) for each sales area.
        6. The polygons should be simple and non-overlapping.
        7. Try to fill the space efficiently, maintaining logical flow and spatial relationships between related departments.
        8. Consider the entrance location for the general flow of the store.
        
        Please provide a JSON array of objects, where each object has:
        - id: the request id
        - points: an array of {x, y} vertices for the proposed polygon.
      `;

      const response = await ai.models.generateContent({
        model: model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.INTEGER },
                points: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      x: { type: Type.NUMBER },
                      y: { type: Type.NUMBER }
                    },
                    required: ["x", "y"]
                  }
                }
              },
              required: ["id", "points"]
            }
          }
        }
      });

      const proposal = JSON.parse(response.text);
      const newDrawnAreas: DrawnSalesArea[] = [];

      for (const item of proposal) {
        const request = requests.find(r => r.id === item.id);
        if (request) {
          const areaM2 = this.geometryService.calculateArea(item.points, scale);
          newDrawnAreas.push({
            ...request,
            points: item.points,
            centroid: this.calculateCentroid(item.points),
            actualAreaM2: areaM2,
            cells: [] // We don't need cells for AI generated polygons
          });
        }
      }

      this.drawnSalesAreas.set(newDrawnAreas);
      this.saveState();
    } catch (error) {
      console.error("AI Proposal Error:", error);
      alert("Failed to generate AI proposal. Please try again.");
    } finally {
      this.isGeneratingAI.set(false);
    }
  }

  // --- Excel Export ---
  exportToExcel(): void {
    const areas = this.drawnSalesAreas();
    if (areas.length === 0) {
      alert("No hay áreas generadas para exportar.");
      return;
    }

    const scale = this.pixelsPerMeter();
    const isMetric = this.unitSystem() === 'metric';
    const unitFactor = isMetric ? 1 : 3.28084;
    const areaFactor = isMetric ? 1 : 10.7639;
    const unitSuffix = isMetric ? '(m)' : '(ft)';
    const areaSuffix = isMetric ? '(m2)' : '(sq ft)';
    const bounds = this.layoutBounds();

    const data = areas.map((area, index) => {
      // Use absolute Cartesian coordinates (relative to 0,0)
      const centroidX = (area.centroid.x / scale) * unitFactor;
      const centroidY = (-area.centroid.y / scale) * unitFactor; // Invert Y for Cartesian

      // Get boundary points in absolute Cartesian units
      const pointsInUnits = area.points.map(p => ({
        x: (p.x / scale) * unitFactor,
        y: (-p.y / scale) * unitFactor
      }));

      const boundaryPointsStr = pointsInUnits
        .map(p => `${p.x.toFixed(4)},${p.y.toFixed(4)}`)
        .join(';');

      // Create line segments string
      const segments: string[] = [];
      for (let i = 0; i < pointsInUnits.length; i++) {
        const p1 = pointsInUnits[i];
        const p2 = pointsInUnits[(i + 1) % pointsInUnits.length];
        segments.push(`(${p1.x.toFixed(4)},${p1.y.toFixed(4)})/(${p2.x.toFixed(4)},${p2.y.toFixed(4)})`);
      }
      const segmentsStr = segments.join('; ');

      const row: any = {
        'Room Name': area.name,
        'Room Number': (index + 101).toString(),
        'Division': area.division
      };

      row[`Area ${areaSuffix}`] = (area.actualAreaM2 * areaFactor).toFixed(2);
      row[`Centroid X ${unitSuffix}`] = centroidX.toFixed(4);
      row[`Centroid Y ${unitSuffix}`] = centroidY.toFixed(4);
      row[`Boundary Points ${unitSuffix}`] = boundaryPointsStr;
      row[`Line Segments ${unitSuffix}`] = segmentsStr;

      return row;
    });

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sales Areas');

    // Generate buffer and trigger download
    XLSX.writeFile(workbook, `SalesAreas_Revit_Export_${new Date().getTime()}.xlsx`);
  }

  private getAreaBoundaryPoints(cells: Point[]): Point[] {
    const cellSet = new Set(cells.map(c => `${c.x},${c.y}`));
    const edges: { p1: Point; p2: Point }[] = [];

    for (const cell of cells) {
      const neighbors = [
        { x: cell.x, y: cell.y - 1, p1: { x: cell.x, y: cell.y }, p2: { x: cell.x + 1, y: cell.y } }, // Top
        { x: cell.x + 1, y: cell.y, p1: { x: cell.x + 1, y: cell.y }, p2: { x: cell.x + 1, y: cell.y + 1 } }, // Right
        { x: cell.x, y: cell.y + 1, p1: { x: cell.x + 1, y: cell.y + 1 }, p2: { x: cell.x, y: cell.y + 1 } }, // Bottom
        { x: cell.x - 1, y: cell.y, p1: { x: cell.x, y: cell.y + 1 }, p2: { x: cell.x, y: cell.y } }  // Left
      ];

      for (const n of neighbors) {
        if (!cellSet.has(`${n.x},${n.y}`)) {
          edges.push({ p1: n.p1, p2: n.p2 });
        }
      }
    }

    if (edges.length === 0) return [];

    // Order edges to form a closed loop
    const orderedPoints: Point[] = [];
    let currentEdge = edges[0];
    orderedPoints.push(currentEdge.p1);
    
    const remainingEdges = new Set(edges.slice(1));
    let currentPoint = currentEdge.p2;

    while (remainingEdges.size > 0) {
      let found = false;
      for (const edge of remainingEdges) {
        if (Math.abs(edge.p1.x - currentPoint.x) < 0.1 && Math.abs(edge.p1.y - currentPoint.y) < 0.1) {
          orderedPoints.push(edge.p1);
          currentPoint = edge.p2;
          remainingEdges.delete(edge);
          found = true;
          break;
        } else if (Math.abs(edge.p2.x - currentPoint.x) < 0.1 && Math.abs(edge.p2.y - currentPoint.y) < 0.1) {
          orderedPoints.push(edge.p2);
          currentPoint = edge.p1;
          remainingEdges.delete(edge);
          found = true;
          break;
        }
      }
      if (!found) break; // Should not happen for closed shapes
    }

    if (orderedPoints.length === 0) return [];

    // Simplify: remove collinear points
    const simplified: Point[] = [];
    for (let i = 0; i < orderedPoints.length; i++) {
        const prev = i === 0 ? orderedPoints[orderedPoints.length - 1] : orderedPoints[i - 1];
        const curr = orderedPoints[i];
        const next = orderedPoints[(i + 1) % orderedPoints.length];
        
        // Cross product to check collinearity
        const isCollinear = Math.abs((next.y - prev.y) * (curr.x - prev.x) - (next.x - prev.x) * (curr.y - prev.y)) < 0.001;
        
        if (!isCollinear) {
            simplified.push(curr);
        }
    }

    return simplified.length > 0 ? simplified : orderedPoints;
  }
  
  toggleViewMode(): void {
    this.viewMode.update(m => m === '2d' ? '3d' : '2d');
  }

  // --- History Management ---
  saveState(): void {
    if (this.isRestoringState) return;
    const state: AppState = {
      points: this.points(),
      isClosed: this.isClosed(),
      pixelsPerMeter: this.pixelsPerMeter(),
      customCorridors: this.customCorridors(),
      nextCorridorId: this.nextCorridorId,
      walls: this.walls(),
      nextWallId: this.nextWallId,
      salesAreaRequests: this.salesAreaRequests(),
      drawnSalesAreas: this.drawnSalesAreas(),
      nextSalesAreaId: this.nextSalesAreaId,
      entrance: this.entrance()
    };
    // Prevent saving identical subsequent states
    if (this.historyPointer > -1 && JSON.stringify(state) === JSON.stringify(this.history[this.historyPointer])) {
        return;
    }
    this.history = this.history.slice(0, this.historyPointer + 1);
    this.history.push(state);
    this.historyPointer++;
    this.updateHistorySignals();
  }

  private restoreState(state: AppState): void {
    this.isRestoringState = true;
    this.points.set(state.points);
    this.isClosed.set(state.isClosed);
    this.pixelsPerMeter.set(state.pixelsPerMeter);
    this.customCorridors.set(state.customCorridors ?? []);
    this.nextCorridorId = state.nextCorridorId;
    this.walls.set(state.walls ?? []);
    this.nextWallId = state.nextWallId ?? 0;
    this.salesAreaRequests.set(state.salesAreaRequests ?? []);
    this.drawnSalesAreas.set(state.drawnSalesAreas ?? []);
    this.nextSalesAreaId = state.nextSalesAreaId ?? 0;
    this.entrance.set(state.entrance ?? null);
    this.selectedVertex.set(null);
    this.draggedVertex.set(null);
    this.isRestoringState = false;
  }

  undo(): void {
    if (this.canUndo()) {
      this.historyPointer--;
      const state = this.history[this.historyPointer];
      this.restoreState(state);
      this.updateHistorySignals();
    }
  }

  redo(): void {
    if (this.canRedo()) {
      this.historyPointer++;
      const state = this.history[this.historyPointer];
      this.restoreState(state);
      this.updateHistorySignals();
    }
  }

  private updateHistorySignals(): void {
    this.canUndo.set(this.historyPointer > 0);
    this.canRedo.set(this.historyPointer < this.history.length - 1);
  }

  private updateCustomCorridorPoint(id: number, pointIndex: number, newPoint: Point): void {
    this.customCorridors.update(corridors => {
      const corridorIndex = corridors.findIndex(c => c.id === id);
      if (corridorIndex === -1) return corridors;

      const newCorridors = [...corridors];
      const corridorToUpdate = { ...newCorridors[corridorIndex] };
      const newCenterline = [...corridorToUpdate.centerline];
      newCenterline[pointIndex] = newPoint;
      corridorToUpdate.centerline = newCenterline;

      const widthInPixels = 2 * this.pixelsPerMeter();
      const { boundary1, boundary2 } = this.geometryService.generateCorridorBoundaries(newCenterline, widthInPixels);
      corridorToUpdate.boundary1 = boundary1;
      corridorToUpdate.boundary2 = boundary2;

      newCorridors[corridorIndex] = corridorToUpdate;
      return newCorridors;
    });
  }
}
