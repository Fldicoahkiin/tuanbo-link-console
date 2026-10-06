// Artificial geometry for labeled pixel tests, never used for real detection.
export function fixtureMesh(positions, center, eyes) {
  const points = Array.from({ length: 478 }, () => [...center]);
  for (const [id, position] of Object.entries(positions)) points[Number(id)] = position;
  const outer = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
  const inner = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
  const cx = (positions[61][0] + positions[291][0]) / 2;
  const cy = (positions[0][1] + positions[17][1]) / 2;
  const rx = Math.abs(positions[61][0] - positions[291][0]) / 2;
  const ry = Math.abs(positions[0][1] - positions[17][1]) / 2;
  for (const [contour, scaleX, scaleY] of [[outer, 1, 1], [inner, .75, .35]]) {
    contour.forEach((id, index) => {
      const angle = Math.PI - index * Math.PI / 10;
      points[id] = [cx + Math.cos(angle) * rx * scaleX, cy + Math.sin(angle) * ry * scaleY];
    });
  }
  const contours = [[33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246],
    [263,249,390,373,374,380,381,382,362,398,384,385,386,387,388,466],
    [46,53,52,65,55,107,66,105,63,70], [276,283,282,295,285,336,296,334,293,300]];
  contours.forEach((contour, part) => contour.forEach((id, index) => {
    const side = part % 2, brow = part >= 2;
    const angle = side ? index * 2 * Math.PI / contour.length : Math.PI - index * 2 * Math.PI / contour.length;
    points[id] = [eyes[side * 2] + Math.cos(angle) * (brow ? .04 : .025),
      eyes[side * 2 + 1] - (brow ? .05 : 0) + Math.sin(angle) * (brow ? .006 : .018)];
  }));
  points[234] = [center[0] - (eyes[2] - eyes[0]) * 1.5, center[1]];
  points[454] = [center[0] + (eyes[2] - eyes[0]) * 1.5, center[1]];
  return Object.fromEntries(points.flatMap((point, index) => [[`p${index}x`, point[0]], [`p${index}y`, point[1]]]));
}
