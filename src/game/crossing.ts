import { POINTS_PER_MM, PointMm, ScreenPose, ScreenSize, Stitch, screenPoses, tableToScreen } from '../spatial/Stitch';
import { isBug } from './persistence';
import { Bug, Habitat, HabitatEdge } from './types';

/**
 * Lets bugs walk from one phone's habitat into the other's. The swipe join says where the two
 * screens lie on the table; each phone also tells the other where its habitat is drawn on its
 * screen (the whole screen). A wall is open where a straight walk out of it reaches the other
 * habitat across the bezels, and the bug arrives at that point, still heading the same way.
 */

/** The habitat's drawn rectangle, in screen points from the window's top-left corner. */
export type FieldRect = { xPt: number; yPt: number; widthPt: number; heightPt: number };
export type HabitatLayout = { screen: ScreenSize; field: FieldRect; habitat: Habitat };

export type CrossingLink = {
  own: ScreenPose;
  other: ScreenPose;
  ownLayout: HabitatLayout;
  otherLayout: HabitatLayout;
};

export type Landing = { x: number; y: number; heading: number };

/**
 * Furthest a bug may jump between habitats. Habitats fill their screens, so the gap is the two
 * bezels (7 mm) plus slack for cases and an imperfect join: bugs cross only where the screens' edges meet.
 */
export const MAX_CROSSING_GAP_MM = 15;
const SEARCH_STEP_MM = 1;
/** Arrivals start this far inside the wall, in habitat units, so they don't bounce straight back. */
const ARRIVAL_INSET = 10;
/** Arriving bugs heading this close to along the wall are turned to walk straight in. */
const MIN_INWARD_COSINE = 0.3;
/**
 * Both phones use this heading in the join. Phone A's screen frame then is the table frame, so
 * the join needs no motion data, and phones turned after the join need a new swipe.
 */
export const FIXED_JOIN_HEADING = Math.PI / 2;

const rotate = ({ x, y }: PointMm, angleRad: number): PointMm => ({
  x: x * Math.cos(angleRad) - y * Math.sin(angleRad),
  y: x * Math.sin(angleRad) + y * Math.cos(angleRad),
});

const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

/** Screen frame with +y up (towards the top edge). */
const OUTWARD: Record<HabitatEdge, PointMm> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: 1 }, bottom: { x: 0, y: -1 } };

/** Both screens' places on the table from a join made with `FIXED_JOIN_HEADING`. */
export function crossingPoses(stitch: Stitch, role: 'A' | 'B'): { own: ScreenPose; other: ScreenPose } {
  const poses = screenPoses(stitch, FIXED_JOIN_HEADING, FIXED_JOIN_HEADING + stitch.relativeYawRad);
  return role === 'A' ? { own: poses.A, other: poses.B } : { own: poses.B, other: poses.A };
}

/** Inverse of `tableToScreen`. */
export function screenToTable(point: { xPt: number; yPt: number }, pose: ScreenPose, screen: ScreenSize, pointsPerMm = POINTS_PER_MM): PointMm {
  const local = { x: (point.xPt - screen.widthPt / 2) / pointsPerMm, y: (screen.heightPt / 2 - point.yPt) / pointsPerMm };
  const turned = rotate(local, pose.headingRad - Math.PI / 2);
  return { x: pose.centreMm.x + turned.x, y: pose.centreMm.y + turned.y };
}

export const habitatToScreen = ({ x, y }: { x: number; y: number }, { field, habitat }: HabitatLayout) => ({
  xPt: field.xPt + (x / habitat.width) * field.widthPt,
  yPt: field.yPt + (y / habitat.height) * field.heightPt,
});

export const screenToHabitat = ({ xPt, yPt }: { xPt: number; yPt: number }, { field, habitat }: HabitatLayout) => ({
  x: ((xPt - field.xPt) / field.widthPt) * habitat.width,
  y: ((yPt - field.yPt) / field.heightPt) * habitat.height,
});

const insideField = ({ xPt, yPt }: { xPt: number; yPt: number }, { field }: HabitatLayout) =>
  xPt >= field.xPt && xPt <= field.xPt + field.widthPt && yPt >= field.yPt && yPt <= field.yPt + field.heightPt;

/**
 * Habitat headings run clockwise on screen (y down); table angles run anticlockwise. A heading
 * crosses phones by way of the table.
 */
const headingToTable = (heading: number, pose: ScreenPose) => -heading + pose.headingRad - Math.PI / 2;
const tableToHeading = (angle: number, pose: ScreenPose) => wrapAngle(-(angle - (pose.headingRad - Math.PI / 2)));

/** Where a bug leaving this habitat at `point` through `edge` arrives in the other, or null if that wall is closed. */
export function crossingLanding(link: CrossingLink, point: { x: number; y: number }, edge: HabitatEdge, heading: number): Landing | null {
  const start = screenToTable(habitatToScreen(point, link.ownLayout), link.own, link.ownLayout.screen);
  const out = rotate(OUTWARD[edge], link.own.headingRad - Math.PI / 2);
  for (let gap = SEARCH_STEP_MM; gap <= MAX_CROSSING_GAP_MM; gap += SEARCH_STEP_MM) {
    const onOther = tableToScreen({ x: start.x + out.x * gap, y: start.y + out.y * gap }, link.other, link.otherLayout.screen);
    if (!insideField(onOther, link.otherLayout)) continue;
    const arrival = screenToHabitat(onOther, link.otherLayout);
    const inward = tableToHeading(Math.atan2(out.y, out.x), link.other);
    const carried = tableToHeading(headingToTable(heading, link.own), link.other);
    const { width, height } = link.otherLayout.habitat;
    return {
      x: Math.min(width - ARRIVAL_INSET, Math.max(ARRIVAL_INSET, arrival.x + Math.cos(inward) * ARRIVAL_INSET)),
      y: Math.min(height - ARRIVAL_INSET, Math.max(ARRIVAL_INSET, arrival.y + Math.sin(inward) * ARRIVAL_INSET)),
      heading: Math.cos(carried - inward) >= MIN_INWARD_COSINE ? carried : inward,
    };
  }
  return null;
}

export type GateSegment = { edge: HabitatEdge; from: number; to: number };

/** The open stretches of each wall, in habitat units along it, for drawing. */
export function openGates(link: CrossingLink, sampleStep = 4): GateSegment[] {
  const { width, height } = link.ownLayout.habitat;
  const segments: GateSegment[] = [];
  const walls: { edge: HabitatEdge; length: number; at: (along: number) => { x: number; y: number } }[] = [
    { edge: 'left', length: height, at: (along) => ({ x: 0, y: along }) },
    { edge: 'right', length: height, at: (along) => ({ x: width, y: along }) },
    { edge: 'top', length: width, at: (along) => ({ x: along, y: 0 }) },
    { edge: 'bottom', length: width, at: (along) => ({ x: along, y: height }) },
  ];
  for (const wall of walls) {
    let openFrom: number | null = null;
    for (let along = 0; along <= wall.length; along += sampleStep) {
      const open = crossingLanding(link, wall.at(along), wall.edge, 0) != null;
      if (open && openFrom == null) openFrom = along;
      if (!open && openFrom != null) {
        segments.push({ edge: wall.edge, from: openFrom, to: along - sampleStep });
        openFrom = null;
      }
    }
    if (openFrom != null) segments.push({ edge: wall.edge, from: openFrom, to: wall.length });
  }
  return segments;
}

const CROSSING_MESSAGE_TYPE = 'distbugs.crossing';

export type CrossingMessage =
  /** Where this phone draws its habitat; sent on connecting and whenever it changes. */
  | { type: 'layout'; layout: HabitatLayout | null }
  /** A bug walking over, already placed in the receiver's habitat. */
  | { type: 'bug'; transferId: string; bug: Bug; landing: Landing }
  /** The receiver took the bug, or turned it back (paused, full, or not running). */
  | { type: 'bug-ack'; transferId: string; accepted: boolean };

export const serializeCrossingMessage = (message: CrossingMessage): string =>
  JSON.stringify({ type: CROSSING_MESSAGE_TYPE, version: 1, message });

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isLayout = (value: unknown): value is HabitatLayout => {
  if (!isObject(value) || !isObject(value.screen) || !isObject(value.field) || !isObject(value.habitat)) return false;
  const { screen, field, habitat } = value;
  return isNumber(screen.widthPt) && isNumber(screen.heightPt)
    && isNumber(field.xPt) && isNumber(field.yPt) && isNumber(field.widthPt) && field.widthPt > 0 && isNumber(field.heightPt) && field.heightPt > 0
    && isNumber(habitat.width) && isNumber(habitat.height);
};

export function parseCrossingMessage(text: string): CrossingMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(parsed) || parsed.type !== CROSSING_MESSAGE_TYPE || !isObject(parsed.message)) return null;
  const message = parsed.message;
  if (message.type === 'layout') return message.layout === null || isLayout(message.layout) ? message as CrossingMessage : null;
  if (message.type === 'bug') {
    const { landing } = message;
    const valid = typeof message.transferId === 'string' && isBug(message.bug)
      && isObject(landing) && isNumber(landing.x) && isNumber(landing.y) && isNumber(landing.heading);
    return valid ? message as CrossingMessage : null;
  }
  if (message.type === 'bug-ack') {
    return typeof message.transferId === 'string' && typeof message.accepted === 'boolean' ? message as CrossingMessage : null;
  }
  return null;
}
