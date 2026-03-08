
import { Injectable } from '@angular/core';
import { Point } from './models';

@Injectable({
  providedIn: 'root'
})
export class GeometryService {
  calculateArea(points: Point[], pixelsPerMeter: number): number {
    if (points.length < 3 || pixelsPerMeter <= 0) return 0;
    
    let area = 0;
    for (let i = 0; i < points.length; i++) {
      const p1 = points[i];
      const p2 = points[(i + 1) % points.length];
      area += (p1.x * p2.y) - (p2.x * p1.y);
    }
    
    const areaInPixels = Math.abs(area) / 2;
    return areaInPixels / (pixelsPerMeter * pixelsPerMeter);
  }

  splitPolygon(polygon: Point[], axis: 'x' | 'y', value: number): { left: Point[][], right: Point[][] } {
    const leftPart: Point[] = [];
    const rightPart: Point[] = [];

    const isLeft = (p: Point) => axis === 'x' ? p.x <= value : p.y <= value;

    for (let i = 0; i < polygon.length; i++) {
      const p1 = polygon[i];
      const p2 = polygon[(i + 1) % polygon.length];

      const p1Left = isLeft(p1);
      const p2Left = isLeft(p2);

      if (p1Left) leftPart.push(p1);
      if (!p1Left) rightPart.push(p1);

      if (p1Left !== p2Left) {
        // Intersection
        let intersect: Point;
        if (axis === 'x') {
          const t = (value - p1.x) / (p2.x - p1.x);
          intersect = { x: value, y: p1.y + t * (p2.y - p1.y) };
        } else {
          const t = (value - p1.y) / (p2.y - p1.y);
          intersect = { x: p1.x + t * (p2.x - p1.x), y: value };
        }
        leftPart.push(intersect);
        rightPart.push(intersect);
      }
    }

    // This simple split might produce multiple polygons if the input is non-convex.
    // For simplicity in this architectural tool, we'll return them as single polygons 
    // but in a real clipper we'd need to handle multiple loops.
    // We'll wrap them in arrays to allow for future multi-polygon support.
    return { 
      left: leftPart.length >= 3 ? [leftPart] : [], 
      right: rightPart.length >= 3 ? [rightPart] : [] 
    };
  }

  calculateSegments(points: Point[], isClosed: boolean, pixelsPerMeter: number) {
    if (points.length < 2 || pixelsPerMeter <= 0) return [];
    const segments = [];
    const numSegments = isClosed ? points.length : points.length - 1;

    for (let i = 0; i < numSegments; i++) {
      const p1 = points[i];
      const p2 = points[(i + 1) % points.length];
      const pixelLength = Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
      segments.push({
        p1, p2,
        midpoint: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
        length: pixelLength / pixelsPerMeter
      });
    }
    return segments;
  }

  generateCorridorBoundaries(points: Point[], width: number): { boundary1: Point[], boundary2: Point[] } {
    const halfWidth = width / 2;
    return {
      boundary1: this.generateOffsetPolyline(points, halfWidth),
      boundary2: this.generateOffsetPolyline(points, -halfWidth)
    };
  }

  private generateOffsetPolyline(points: Point[], offset: number): Point[] {
    if (points.length < 2) return [];
    const newPoints: Point[] = [];

    // Start Cap
    const v_out_start = { x: points[1].x - points[0].x, y: points[1].y - points[0].y };
    const mag_start = Math.sqrt(v_out_start.x ** 2 + v_out_start.y ** 2);
    if (mag_start > 1e-6) {
      const n_start = { x: -v_out_start.y / mag_start, y: v_out_start.x / mag_start };
      newPoints.push({ x: points[0].x + n_start.x * offset, y: points[0].y + n_start.y * offset });
    }

    // Mid points
    for (let i = 1; i < points.length - 1; i++) {
      const p_prev = points[i - 1];
      const p_curr = points[i];
      const p_next = points[i + 1];

      const v_in = { x: p_curr.x - p_prev.x, y: p_curr.y - p_prev.y };
      const v_out = { x: p_next.x - p_curr.x, y: p_next.y - p_curr.y };
      const v_in_mag = Math.sqrt(v_in.x ** 2 + v_in.y ** 2);
      const v_out_mag = Math.sqrt(v_out.x ** 2 + v_out.y ** 2);

      if (v_in_mag < 1e-6 || v_out_mag < 1e-6) continue;

      const v_in_norm = { x: v_in.x / v_in_mag, y: v_in.y / v_in_mag };
      const v_out_norm = { x: v_out.x / v_out_mag, y: v_out.y / v_out_mag };
      const n1 = { x: -v_in_norm.y, y: v_in_norm.x };
      const n2 = { x: -v_out_norm.y, y: v_out_norm.x };
      const bisector = { x: n1.x + n2.x, y: n1.y + n2.y };
      const bisector_mag = Math.sqrt(bisector.x ** 2 + bisector.y ** 2);
      const fallbackPoint = { x: p_curr.x + n1.x * offset, y: p_curr.y + n1.y * offset };

      if (bisector_mag < 1e-6) {
        newPoints.push(fallbackPoint);
        continue;
      }

      const bisector_norm = { x: bisector.x / bisector_mag, y: bisector.y / bisector_mag };
      const dot = n1.x * n2.x + n1.y * n2.y;
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
      const cos_half_angle = Math.cos(angle / 2);

      if (cos_half_angle < 1e-6) {
        newPoints.push(fallbackPoint);
        continue;
      }

      const miter_length = offset / cos_half_angle;
      newPoints.push({
        x: p_curr.x + bisector_norm.x * miter_length,
        y: p_curr.y + bisector_norm.y * miter_length
      });
    }

    // End Cap
    const v_in_end = { x: points[points.length - 1].x - points[points.length - 2].x, y: points[points.length - 1].y - points[points.length - 2].y };
    const mag_end = Math.sqrt(v_in_end.x ** 2 + v_in_end.y ** 2);
    if (mag_end > 1e-6) {
      const n_end = { x: -v_in_end.y / mag_end, y: v_in_end.x / mag_end };
      newPoints.push({ x: points[points.length - 1].x + n_end.x * offset, y: points[points.length - 1].y + n_end.y * offset });
    }

    return newPoints;
  }
}
