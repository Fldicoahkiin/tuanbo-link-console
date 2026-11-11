import { describe, expect, it } from 'vitest';
import { contentPoint, contentRectangle, dropPlacement, EDGE_SCROLL_MAX_SPEED, EDGE_SCROLL_MIN_SPEED, EDGE_SCROLL_ZONE, edgeScrollSpeed, intersects, selectionRectangle, type ScrollBox } from './program-grid-geometry';

// The rundown on a 1280×720 window: below the title bar and the player, right of the sidebar.
const offset: ScrollBox = { left: 248, top: 312, clientLeft: 0, clientTop: 0, scrollLeft: 0, scrollTop: 0, scrollWidth: 760, scrollHeight: 900 };

describe('首页框选的方框跟着鼠标', () => {
  it('列表不在窗口左上角时，方框画在按下和现在鼠标所在的位置', () => {
    const start = contentPoint(300, 340, offset), now = contentPoint(420, 400, offset);
    // 0.5.8 drew the box at (300, 340) inside the workspace, which put it 248 px right and 312 px lower.
    expect(selectionRectangle(start, now)).toEqual({ left: 52, top: 28, width: 120, height: 60 });
  });

  it('列表滚动过以后，方框和卡片都按滚动后的内容位置算', () => {
    const scrolled: ScrollBox = { ...offset, scrollTop: 200, clientLeft: 1, clientTop: 1 };
    const start = contentPoint(300, 340, scrolled);
    expect(start).toEqual({ x: 51, y: 227 });
    // Scrolling while the button is held: the start stays on the content, the box grows with it.
    const later: ScrollBox = { ...scrolled, scrollTop: 260 };
    expect(selectionRectangle(start, contentPoint(300, 400, later))).toEqual({ left: 51, top: 227, width: 0, height: 120 });
    const card = contentRectangle({ left: 260, top: 330, width: 232, height: 92 }, scrolled);
    expect(card).toEqual({ left: 11, top: 217, width: 232, height: 92 });
    expect(intersects(selectionRectangle(start, contentPoint(320, 360, scrolled)), card)).toBe(true);
    expect(intersects(selectionRectangle(contentPoint(600, 600, scrolled), contentPoint(700, 700, scrolled)), card)).toBe(false);
  });

  it('拖到列表外面时，方框停在列表内容的边上，不会把列表撑大', () => {
    expect(contentPoint(0, 0, offset)).toEqual({ x: 0, y: 0 });
    expect(contentPoint(5000, 5000, offset)).toEqual({ x: 760, y: 900 });
  });
});

describe('拖动排序的插入位置', () => {
  const card = { left: 100, top: 100, width: 200, height: 80 };
  it('卡片看左右半边，列表看上下半边', () => {
    expect(dropPlacement(150, 170, card, 'cards')).toBe('before');
    expect(dropPlacement(250, 110, card, 'cards')).toBe('after');
    expect(dropPlacement(290, 120, card, 'list')).toBe('before');
    expect(dropPlacement(110, 160, card, 'list')).toBe('after');
  });
});

describe('拖到列表上下边缘时自动滚动', () => {
  // The rundown on a 1280×720 window, 360 px high.
  const list = { left: 248, top: 312, width: 760, height: 360 };
  const at = (y: number, x = 500): number => edgeScrollSpeed({ x, y }, list);
  it('中间不滚；进了边缘带开始滚，越靠边越快，上边往上、下边往下', () => {
    expect(at(312 + 180)).toBe(0);
    expect(at(312 + EDGE_SCROLL_ZONE)).toBe(0);
    const entering = at(312 + EDGE_SCROLL_ZONE - 1), nearer = at(312 + 10), onEdge = at(312);
    expect(entering).toBeLessThan(0); expect(entering).toBeGreaterThan(-EDGE_SCROLL_MIN_SPEED - 30);
    expect(nearer).toBeLessThan(entering); expect(onEdge).toBe(-EDGE_SCROLL_MAX_SPEED);
    expect(at(672 - EDGE_SCROLL_ZONE + 1)).toBeGreaterThan(0);
    expect(at(672 - 10)).toBeGreaterThan(at(672 - 40));
    expect(at(672)).toBe(EDGE_SCROLL_MAX_SPEED);
  });
  it('刚拖出列表上下边时照样最快，离远了或拖到列表左右以外就停', () => {
    expect(at(312 - 20)).toBe(-EDGE_SCROLL_MAX_SPEED);
    expect(at(672 + 20)).toBe(EDGE_SCROLL_MAX_SPEED);
    expect(at(312 - EDGE_SCROLL_ZONE - 1)).toBe(0);
    expect(at(672 + EDGE_SCROLL_ZONE + 1)).toBe(0);
    expect(at(320, 100)).toBe(0); expect(at(660, 1100)).toBe(0);
  });
  it('很矮的列表两条边缘带各占一半，没有高度就不滚', () => {
    const short = { ...list, height: 60 };
    expect(edgeScrollSpeed({ x: 500, y: 312 + 29 }, short)).toBeLessThan(0);
    expect(edgeScrollSpeed({ x: 500, y: 312 + 31 }, short)).toBeGreaterThan(0);
    expect(edgeScrollSpeed({ x: 500, y: 312 }, { ...list, height: 0 })).toBe(0);
  });
});
