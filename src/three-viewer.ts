import { Component, ElementRef, Input, OnChanges, OnDestroy, SimpleChanges, ViewChild, AfterViewInit } from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Point, DrawnSalesArea, CustomCorridor, Wall } from './models';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'app-three-viewer',
  standalone: true,
  imports: [MatIconModule],
  template: `
    <div class="relative w-full h-full">
      <div #container class="w-full h-full bg-zinc-950 rounded-3xl overflow-hidden border border-zinc-800 shadow-inner"></div>
      
      <div class="absolute top-4 right-4 flex flex-col gap-2">
        <button 
          (click)="setControlMode('rotate')"
          [class.bg-sky-600]="controlMode === 'rotate'"
          [class.text-white]="controlMode === 'rotate'"
          [class.bg-zinc-900]="controlMode !== 'rotate'"
          class="p-2 rounded-lg shadow-md hover:bg-zinc-800 transition-colors flex items-center justify-center border border-zinc-700"
          title="Rotate Mode"
        >
          <mat-icon>rotate_left</mat-icon>
        </button>
        <button 
          (click)="setControlMode('pan')"
          [class.bg-sky-600]="controlMode === 'pan'"
          [class.text-white]="controlMode === 'pan'"
          [class.bg-zinc-900]="controlMode !== 'pan'"
          class="p-2 rounded-lg shadow-md hover:bg-zinc-800 transition-colors flex items-center justify-center border border-zinc-700"
          title="Pan Mode"
        >
          <mat-icon>pan_tool</mat-icon>
        </button>
        <button 
          (click)="resetView()"
          class="p-2 bg-zinc-900 rounded-lg shadow-md hover:bg-zinc-800 transition-colors flex items-center justify-center border border-zinc-700"
          title="Reset View"
        >
          <mat-icon>restart_alt</mat-icon>
        </button>
      </div>
    </div>
  `,
  styles: [`:host { display: block; width: 100%; height: 100%; }`]
})
export class ThreeViewer implements OnChanges, OnDestroy, AfterViewInit {
  @ViewChild('container', { static: true }) containerRef!: ElementRef<HTMLDivElement>;

  @Input() points: Point[] = [];
  @Input() isClosed: boolean = false;
  @Input() drawnSalesAreas: DrawnSalesArea[] = [];
  @Input() customCorridors: CustomCorridor[] = [];
  @Input() walls: Wall[] = [];
  @Input() divisionColorMap: Map<string, string> = new Map();
  @Input() pixelsPerMeter: number = 20;
  @Input() unitSystem: 'metric' | 'imperial' = 'metric';
  @Input() sqUnitLabel: string = 'm²';

  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private controls!: OrbitControls;
  private frameId: number | null = null;
  private meshes: THREE.Object3D[] = [];
  
  controlMode: 'rotate' | 'pan' = 'rotate';

  ngOnChanges(changes: SimpleChanges): void {
    if (this.scene) {
      this.updateScene();
    }
  }

  ngAfterViewInit(): void {
    this.initThree();
    this.updateScene();
    this.animate();
  }

  ngOnDestroy(): void {
    if (this.frameId) {
      cancelAnimationFrame(this.frameId);
    }
    this.renderer.dispose();
  }

  private initThree(): void {
    const width = this.containerRef.nativeElement.clientWidth;
    const height = this.containerRef.nativeElement.clientHeight;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x09090b); // zinc-950

    this.camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 5000);
    this.camera.position.set(0, 500, 500);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(width, height);
    this.containerRef.nativeElement.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN
    };

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(100, 200, 100);
    this.scene.add(directionalLight);

    window.addEventListener('resize', this.onResize.bind(this));
  }

  private onResize(): void {
    if (!this.containerRef) return;
    const width = this.containerRef.nativeElement.clientWidth;
    const height = this.containerRef.nativeElement.clientHeight;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  setControlMode(mode: 'rotate' | 'pan'): void {
    this.controlMode = mode;
    if (this.controls) {
      if (mode === 'rotate') {
        this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      } else {
        this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
      }
      this.controls.update();
    }
  }

  resetView(): void {
    if (this.controls) {
      this.controls.reset();
      this.camera.position.set(0, 500, 500);
      this.controls.update();
    }
  }

  private updateScene(): void {
    // Clear old meshes
    this.meshes.forEach(m => this.scene.remove(m));
    this.meshes = [];

    if (this.points.length < 3) return;

    // Center the model
    const bounds = this.getBounds(this.points);
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;

    // 1. Floor
    const shape = new THREE.Shape();
    this.points.forEach((p, i) => {
      const x = p.x - centerX;
      const y = -(p.y - centerY);
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    });
    
    const floorGeo = new THREE.ShapeGeometry(shape);
    const floorMat = new THREE.MeshPhongMaterial({ color: 0x18181b, side: THREE.DoubleSide }); // zinc-900
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.rotation.x = -Math.PI / 2;
    this.scene.add(floorMesh);
    this.meshes.push(floorMesh);

    // 2. Corridors
    this.customCorridors.forEach(corridor => {
      const corridorShape = new THREE.Shape();
      const allPoints = [...corridor.boundary1, ...[...corridor.boundary2].reverse()];
      allPoints.forEach((p, i) => {
        const x = p.x - centerX;
        const y = -(p.y - centerY);
        if (i === 0) corridorShape.moveTo(x, y);
        else corridorShape.lineTo(x, y);
      });
      const corridorGeo = new THREE.ShapeGeometry(corridorShape);
      const corridorMat = new THREE.MeshPhongMaterial({ color: 0x27272a, side: THREE.DoubleSide }); // zinc-800
      const corridorMesh = new THREE.Mesh(corridorGeo, corridorMat);
      corridorMesh.rotation.x = -Math.PI / 2;
      corridorMesh.position.y = 0.1; // Slightly above floor
      this.scene.add(corridorMesh);
      this.meshes.push(corridorMesh);
    });

    // 2.5 Walls
    this.walls.forEach(wall => {
      if (wall.points.length < 3) return;
      const wallShape = new THREE.Shape();
      wall.points.forEach((p, i) => {
        const x = p.x - centerX;
        const y = -(p.y - centerY);
        if (i === 0) wallShape.moveTo(x, y);
        else wallShape.lineTo(x, y);
      });
      
      const extrudeSettings = { depth: 30, bevelEnabled: false };
      const wallGeo = new THREE.ExtrudeGeometry(wallShape, extrudeSettings);
      const wallMat = new THREE.MeshPhongMaterial({ color: 0x52525b, transparent: true, opacity: 0.8 }); // zinc-600
      const wallMesh = new THREE.Mesh(wallGeo, wallMat);
      wallMesh.rotation.x = -Math.PI / 2;
      wallMesh.position.y = 30; // Set position so it sits on floor
      this.scene.add(wallMesh);
      this.meshes.push(wallMesh);
    });

    // 3. Sales Areas
    this.drawnSalesAreas.forEach(area => {
      if (area.points.length < 3) return;
      const colorStr = this.divisionColorMap.get(area.division) || '#808080';
      const color = new THREE.Color(colorStr);
      
      const areaShape = new THREE.Shape();
      area.points.forEach((p, i) => {
        const x = p.x - centerX;
        const y = -(p.y - centerY);
        if (i === 0) areaShape.moveTo(x, y);
        else areaShape.lineTo(x, y);
      });

      const height = 12;
      const extrudeSettings = { depth: height, bevelEnabled: false };
      const areaGeo = new THREE.ExtrudeGeometry(areaShape, extrudeSettings);
      const areaMat = new THREE.MeshPhongMaterial({ color, transparent: true, opacity: 0.7 });
      const areaMesh = new THREE.Mesh(areaGeo, areaMat);
      areaMesh.rotation.x = -Math.PI / 2;
      areaMesh.position.y = height;
      
      this.scene.add(areaMesh);
      this.meshes.push(areaMesh);

      // 4. Labels
      const areaValue = this.unitSystem === 'metric' ? area.actualAreaM2 : area.actualAreaM2 * 10.7639;
      const areaText = `${areaValue.toFixed(1)} ${this.sqUnitLabel}`;
      const labelSprite = this.createLabelSprite(`${area.division}\n${area.name}\n${areaText}`);
      labelSprite.position.set(
        area.centroid.x - centerX,
        height + 15,
        area.centroid.y - centerY
      );
      this.scene.add(labelSprite);
      this.meshes.push(labelSprite);
    });
  }

  private createLabelSprite(text: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    canvas.width = 256;
    canvas.height = 128;

    context.fillStyle = 'rgba(24,24,27,0.85)'; // zinc-900
    context.fillRect(0, 0, canvas.width, canvas.height);
    
    context.font = 'Bold 20px Arial';
    context.fillStyle = '#f4f4f5'; // zinc-100
    context.textAlign = 'center';
    
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      context.fillText(line, 128, 40 + i * 30);
    });

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(60, 30, 1);
    return sprite;
  }

  private getBounds(points: Point[]) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    points.forEach(p => {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    });
    return { minX, minY, maxX, maxY };
  }

  private animate(): void {
    this.frameId = requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
