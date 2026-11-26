import { describe, expect, it } from 'vitest';
import { fixedBlockItemId, OccupancyIndex, resolveFixedBlockTargets } from '../../packages/shared/src';
import { world } from './fixtures';

const subgroups = () => world().ctx.subgroups;
const multiRoom = { id: 'HALL', allowMultiGroup: true, capacity: 40 };
const exclusiveRoom = { id: 'R1', allowMultiGroup: false, capacity: 40 };

describe('OccupancyIndex — slot_occupancy writing rules', () => {
  it('writes teacher, group and exclusive room cells per period', () => {
    const occ = new OccupancyIndex(subgroups());
    occ.addItem({ itemId: 'a', day: 1, startPeriod: 2, duration: 2, teacherIds: ['T1'], groupIds: ['G1'], room: exclusiveRoom });
    for (const p of [2, 3]) {
      expect(occ.isOccupied(1, p, 'teacher', 'T1')).toBe(true);
      expect(occ.isOccupied(1, p, 'group', 'G1')).toBe(true);
      expect(occ.isOccupied(1, p, 'room', 'R1')).toBe(true);
    }
    expect(occ.isOccupied(1, 4, 'teacher', 'T1')).toBe(false);
    expect(occ.toRows('v1')).toHaveLength(6);
    expect(occ.toRows('v1')[0]).toEqual({ versionId: 'v1', dayOfWeek: 1, period: 2, resourceType: 'group', resourceId: 'G1', itemId: 'a' });
  });

  it('whole-group items of a group with subgroups occupy ALL subgroups (never the group row)', () => {
    const occ = new OccupancyIndex(subgroups());
    occ.addItem({ itemId: 'w', day: 1, startPeriod: 1, duration: 1, groupIds: ['G3'] });
    expect(occ.isOccupied(1, 1, 'subgroup', 'G3A')).toBe(true);
    expect(occ.isOccupied(1, 1, 'subgroup', 'G3B')).toBe(true);
    expect(occ.isOccupied(1, 1, 'group', 'G3')).toBe(false);
  });

  it('lets subgroup A and B run in parallel but clashes them with whole-group classes', () => {
    const occ = new OccupancyIndex(subgroups());
    occ.addItem({ itemId: 'a', day: 1, startPeriod: 1, duration: 2, groupIds: ['G3'], subgroupId: 'G3A', teacherIds: ['T3'] });
    expect(occ.canPlace({ itemId: 'b', day: 1, startPeriod: 1, duration: 2, groupIds: ['G3'], subgroupId: 'G3B', teacherIds: ['T4'] })).toBe(true);

    const clashes = occ.findClashes({ itemId: 'w', day: 1, startPeriod: 2, duration: 1, groupIds: ['G3'], teacherIds: ['T1'] });
    expect(clashes).toEqual([
      { day: 1, period: 2, resourceType: 'subgroup', resourceId: 'G3A', blockingItemIds: ['a'], reason: 'exclusive' },
    ]);
    expect(occ.canPlace({ itemId: 'w', day: 1, startPeriod: 3, duration: 1, groupIds: ['G3'] })).toBe(true);
  });

  it('detects teacher and exclusive room clashes, ignoring the candidate itself', () => {
    const occ = new OccupancyIndex();
    occ.addItem({ itemId: 'a', day: 2, startPeriod: 1, duration: 1, teacherIds: ['T1'], groupIds: ['G1'], room: exclusiveRoom });
    const clashes = occ.findClashes({ itemId: 'b', day: 2, startPeriod: 1, duration: 1, teacherIds: ['T1'], groupIds: ['G2'], room: exclusiveRoom });
    expect(clashes.map((c) => c.resourceType).sort()).toEqual(['room', 'teacher']);
    // moving item `a` onto its own cells is not a clash
    expect(occ.canPlace({ itemId: 'a', day: 2, startPeriod: 1, duration: 1, teacherIds: ['T1'], groupIds: ['G1'], room: exclusiveRoom })).toBe(true);
  });

  it('multi-group rooms skip exclusive room cells and track student load for capacity', () => {
    const occ = new OccupancyIndex();
    occ.addItem({ itemId: 'a', day: 1, startPeriod: 1, duration: 1, groupIds: ['G1'], room: multiRoom, studentCount: 30 });
    expect(occ.isOccupied(1, 1, 'room', 'HALL')).toBe(false);
    expect(occ.getRoomLoad(1, 1, 'HALL')).toEqual({ itemIds: ['a'], studentCount: 30 });

    expect(occ.canPlace({ itemId: 'b', day: 1, startPeriod: 1, duration: 1, groupIds: ['G2'], room: multiRoom, studentCount: 10 })).toBe(true);
    const over = occ.findClashes({ itemId: 'c', day: 1, startPeriod: 1, duration: 1, groupIds: ['G2'], room: multiRoom, studentCount: 20 });
    expect(over).toEqual([
      {
        day: 1,
        period: 1,
        resourceType: 'room',
        resourceId: 'HALL',
        blockingItemIds: ['a'],
        reason: 'capacity',
        studentCount: 50,
        capacity: 40,
      },
    ]);
  });

  it('removeItem frees every cell; re-adding an item replaces its old placement', () => {
    const occ = new OccupancyIndex(subgroups());
    occ.addItem({ itemId: 'a', day: 1, startPeriod: 1, duration: 1, teacherIds: ['T1'], groupIds: ['G3'], room: multiRoom, studentCount: 30 });
    occ.addItem({ itemId: 'a', day: 2, startPeriod: 5, duration: 1, teacherIds: ['T1'], groupIds: ['G3'], room: multiRoom, studentCount: 30 });
    expect(occ.isOccupied(1, 1, 'teacher', 'T1')).toBe(false);
    expect(occ.isOccupied(2, 5, 'teacher', 'T1')).toBe(true);
    expect(occ.itemCount).toBe(1);
    expect(occ.removeItem('a')).toBe(true);
    expect(occ.removeItem('a')).toBe(false);
    expect(occ.toRows('v1')).toEqual([]);
    expect(occ.getRoomLoad(2, 5, 'HALL').studentCount).toBe(0);
  });

  it('conflicts() lists cells claimed by ≥2 items in deterministic order; clone() is independent', () => {
    const occ = new OccupancyIndex();
    occ.addItem({ itemId: 'b', day: 1, startPeriod: 1, duration: 1, teacherIds: ['T1'], groupIds: ['G1'] });
    occ.addItem({ itemId: 'a', day: 1, startPeriod: 1, duration: 1, teacherIds: ['T1'], groupIds: ['G2'] });
    const copy = occ.clone();
    expect(occ.conflicts()).toEqual([
      { day: 1, period: 1, resourceType: 'teacher', resourceId: 'T1', blockingItemIds: ['a', 'b'], reason: 'exclusive' },
    ]);
    copy.removeItem('a');
    expect(copy.conflicts()).toEqual([]);
    expect(occ.conflicts()).toHaveLength(1);
  });
});

describe('OccupancyIndex.seedFixedBlocks', () => {
  it('blocks groups (all/levels/groupIds/departmentIds), staffIds and rooms before scheduling', () => {
    const w = world();
    const occ = new OccupancyIndex();
    occ.seedFixedBlocks(
      [
        { id: 'FB1', termId: 'term1', name: 'อวท.', blockType: 'activity', dayOfWeek: 3, startPeriod: 7, duration: 2, roomId: null, appliesTo: { all: true } },
        { id: 'FB2', termId: 'term1', name: 'ประชุมครู', blockType: 'closed', dayOfWeek: 2, startPeriod: 1, duration: 1, roomId: 'HALL', appliesTo: { staffIds: ['T2'] } },
        { id: 'FB3', termId: 'term1', name: 'โฮมรูม ปวส.', blockType: 'activity', dayOfWeek: 1, startPeriod: 1, duration: 1, roomId: null, appliesTo: { levels: ['ปวส.'] } },
      ],
      w.ctx.studentGroups,
      w.ctx.subgroups,
    );
    expect(occ.isOccupied(3, 7, 'group', 'G1')).toBe(true);
    expect(occ.isOccupied(3, 8, 'subgroup', 'G3A')).toBe(true);
    expect(occ.isOccupied(3, 8, 'subgroup', 'G3B')).toBe(true);
    expect(occ.getEntries(3, 7, 'group', 'G1')).toEqual([{ itemId: fixedBlockItemId('FB1'), isFixedBlock: true, studentCount: 0 }]);
    expect(occ.isOccupied(2, 1, 'teacher', 'T2')).toBe(true);
    expect(occ.isOccupied(2, 1, 'teacher', 'T1')).toBe(false);
    expect(occ.isOccupied(1, 1, 'group', 'G2')).toBe(true);
    expect(occ.isOccupied(1, 1, 'group', 'G1')).toBe(false);

    const clash = occ.findClashes({ itemId: 'x', day: 3, startPeriod: 6, duration: 2, groupIds: ['G1'], teacherIds: ['T1'] });
    expect(clash).toEqual([{ day: 3, period: 7, resourceType: 'group', resourceId: 'G1', blockingItemIds: ['fixed:FB1'], reason: 'exclusive' }]);
    // a fixed block closes even a multi-group room
    expect(occ.canPlace({ itemId: 'y', day: 2, startPeriod: 1, duration: 1, room: multiRoom, studentCount: 1 })).toBe(false);
    expect(occ.toRows('v1', { includeFixedBlocks: false })).toEqual([]);
  });

  it('closed blocks for everyone also block the given staff and rooms; empty selectors block nobody', () => {
    const w = world();
    const closed = { id: 'FBX', termId: 'term1', name: 'วันหยุด', blockType: 'closed' as const, dayOfWeek: 5, startPeriod: 1, duration: 8, roomId: null, appliesTo: { all: true } };
    const t = resolveFixedBlockTargets(closed, w.ctx.studentGroups, { staff: w.ctx.staff, rooms: w.ctx.rooms });
    expect(t.groupIds).toEqual(['G1', 'G2', 'G3']);
    expect(t.staffIds).toEqual(['T1', 'T2', 'T3', 'T4']);
    expect(t.roomIds).toHaveLength(5);
    const none = resolveFixedBlockTargets({ ...closed, appliesTo: {} }, w.ctx.studentGroups);
    expect(none).toEqual({ groupIds: [], staffIds: [], roomIds: [] });
  });
});
