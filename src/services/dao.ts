// Disc-at-Once (DAO) support.
//
// A DAO transfer uploads all tracks as one continuous track and afterwards
// rewrites the UTOC so that this single track is divided into the original
// tracks. Because the audio stream is never interrupted, playback is truly
// gapless. The approach (and the cluster/sector/group arithmetic) is ported
// from netmd++ (https://github.com/Jo2003/netmd_plusplus, CNetMdTOC / CSG).
//
// UTOC addressing: a cluster has 32 audio sectors; every pair of sectors holds
// 11 sound groups. Groups 0-5 belong to the even sector, 5-10 to the odd one
// (group 5 overlaps both). The sound group is the smallest addressable unit,
// so that is the granularity of the split points (~11.6ms in SP stereo).
import type { DiscAddress, Fragment, ToC } from 'netmd-tocmanip';

const GROUPS_PER_SECTOR_PAIR = 11;
const GROUPS_PER_CLUSTER = GROUPS_PER_SECTOR_PAIR * 16;
const MAX_SLOT = 255;

export function discAddressToGroups(address: DiscAddress): number {
    return address.cluster * GROUPS_PER_CLUSTER + (address.sector >> 1) * GROUPS_PER_SECTOR_PAIR + address.group;
}

export function groupsToDiscAddress(groups: number): DiscAddress {
    const cluster = Math.floor(groups / GROUPS_PER_CLUSTER);
    const remainder = groups % GROUPS_PER_CLUSTER;
    let sector = Math.floor(remainder / GROUPS_PER_SECTOR_PAIR) * 2;
    const group = remainder % GROUPS_PER_SECTOR_PAIR;
    if (group > 5) {
        sector++;
    }
    return { cluster, sector, group };
}

interface GroupRange {
    start: number; // inclusive
    end: number; // inclusive
    mode: number;
}

function walkFragmentChain(toc: ToC, firstSlot: number): number[] {
    const slots: number[] = [];
    let slot = firstSlot;
    while (slot !== 0) {
        if (slots.includes(slot)) {
            throw new Error(`UTOC fragment chain loops at slot ${slot}`);
        }
        slots.push(slot);
        slot = toc.trackFragmentList[slot].link;
    }
    return slots;
}

// Places split points so that every track gets a share of the DAO track's
// groups proportional to its weight. Rounding is done on the cumulative
// position, so errors never add up across tracks.
export function computeSplitPoints(totalGroups: number, weights: number[]): number[] {
    if (weights.length === 0 || weights.some((w) => !(w > 0))) {
        throw new Error('Every DAO track needs a positive length');
    }
    if (totalGroups < weights.length) {
        throw new Error('The uploaded track is too short to be split');
    }
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const points = [0];
    let cumulative = 0;
    for (let i = 0; i < weights.length - 1; i++) {
        cumulative += weights[i];
        const minimum = points[i] + 1;
        const maximum = totalGroups - (weights.length - 1 - i);
        points.push(Math.min(maximum, Math.max(minimum, Math.round((cumulative * totalGroups) / totalWeight))));
    }
    points.push(totalGroups);
    return points;
}

// Splits the last track on the disc (the freshly uploaded DAO track) into
// `weights.length` consecutive tracks. `trackNumber` is 1-based, like in the UTOC.
// Track titles and timestamps of the new tracks are left empty - titles are
// meant to be set afterwards through the regular NetMD commands.
export function splitDAOTrack(toc: ToC, trackNumber: number, weights: number[]) {
    if (trackNumber < 1 || trackNumber !== toc.nTracks) {
        throw new Error('Only the last track on the disc can be split');
    }
    const newTrackCount = toc.nTracks + weights.length - 1;
    if (newTrackCount > MAX_SLOT) {
        throw new Error('Too many tracks for a single disc');
    }

    const sourceSlots = walkFragmentChain(toc, toc.trackMap[trackNumber]);
    if (sourceSlots.length === 0) {
        throw new Error(`Track ${trackNumber} has no audio fragments`);
    }
    const sourceRanges: GroupRange[] = sourceSlots.map((slot) => {
        const fragment = toc.trackFragmentList[slot];
        return {
            start: discAddressToGroups(fragment.start),
            end: discAddressToGroups(fragment.end),
            mode: fragment.mode,
        };
    });
    if (sourceRanges.some((r) => r.end < r.start)) {
        throw new Error('Invalid fragment found in the uploaded track');
    }
    const totalGroups = sourceRanges.reduce((a, r) => a + (r.end - r.start + 1), 0);
    const points = computeSplitPoints(totalGroups, weights);

    // Map each logical [from, to) range of the DAO track onto the physical fragments.
    const tracks: GroupRange[][] = [];
    for (let i = 0; i < weights.length; i++) {
        const from = points[i];
        const to = points[i + 1];
        const pieces: GroupRange[] = [];
        let logicalStart = 0;
        for (const range of sourceRanges) {
            const length = range.end - range.start + 1;
            const overlapStart = Math.max(from, logicalStart);
            const overlapEnd = Math.min(to, logicalStart + length);
            if (overlapStart < overlapEnd) {
                pieces.push({
                    start: range.start + (overlapStart - logicalStart),
                    end: range.start + (overlapEnd - logicalStart) - 1,
                    mode: range.mode,
                });
            }
            logicalStart += length;
        }
        tracks.push(pieces);
    }

    // The source track's own slots get reused first, then slots from the
    // empty-slot chain (P-EMPTY, `nextFreeTrackSlot`) are taken in order.
    const usedElsewhere = new Set<number>();
    for (let i = 0; i <= toc.nTracks; i++) {
        // Index 0 is the free-area chain (P-FRA), 1..n are the tracks.
        if (i === trackNumber) continue;
        walkFragmentChain(toc, toc.trackMap[i]).forEach((s) => usedElsewhere.add(s));
    }
    const available = [...sourceSlots];
    let emptySlot = toc.nextFreeTrackSlot;
    const piecesNeeded = tracks.reduce((a, p) => a + p.length, 0);
    const visited = new Set<number>();
    while (available.length < piecesNeeded) {
        if (emptySlot === 0) {
            throw new Error('Not enough free UTOC fragment slots to split the track');
        }
        if (visited.has(emptySlot) || usedElsewhere.has(emptySlot) || available.includes(emptySlot)) {
            throw new Error(`UTOC empty-slot chain is corrupted at slot ${emptySlot}`);
        }
        visited.add(emptySlot);
        available.push(emptySlot);
        emptySlot = toc.trackFragmentList[emptySlot].link;
    }
    toc.nextFreeTrackSlot = emptySlot;

    let cursor = 0;
    tracks.forEach((pieces, i) => {
        const number = trackNumber + i;
        const slots = available.slice(cursor, cursor + pieces.length);
        cursor += pieces.length;
        toc.trackMap[number] = slots[0];
        pieces.forEach((piece, j) => {
            const fragment: Fragment = {
                start: groupsToDiscAddress(piece.start),
                end: groupsToDiscAddress(piece.end),
                mode: piece.mode,
                link: j === pieces.length - 1 ? 0 : slots[j + 1],
            };
            toc.trackFragmentList[slots[j]] = fragment;
        });
        if (i > 0) {
            // Make sure no stale entries from long-deleted tracks get picked up.
            if (toc.titleMap) toc.titleMap[number] = 0;
            if (toc.timestampMap) toc.timestampMap[number] = 0;
            if (toc.fullWidthTitleMap) toc.fullWidthTitleMap[number] = 0;
        }
    });
    toc.nTracks = newTrackCount;

    return points;
}

const TITLE_CELL_LENGTH = 7;

// Writes an already encoded title for `trackNumber` into the UTOC title cells,
// taking cells from the free title chain. Returns false (leaving the ToC
// untouched) if there are not enough free cells.
// This is needed because the firmware-level ToC commit used by DAO does not
// refresh the device's NetMD view of the disc, so the new tracks cannot be
// renamed through regular NetMD commands until the disc is reloaded.
export function setTrackTitleInTOC(toc: ToC, trackNumber: number, encodedTitle: Uint8Array, fullWidth: boolean): boolean {
    const map = fullWidth ? toc.fullWidthTitleMap : toc.titleMap;
    const cells = fullWidth ? toc.fullWidthTitleCellList : toc.titleCellList;
    if (!map || !cells) return false;
    if (map[trackNumber] !== 0) {
        throw new Error(`Track ${trackNumber} already has a title`);
    }
    if (encodedTitle.length === 0) return true;

    const used = new Set<number>();
    for (let i = 0; i <= toc.nTracks; i++) {
        let cell = map[i];
        while (cell !== 0) {
            if (used.has(cell)) break;
            used.add(cell);
            cell = cells[cell].link;
        }
    }

    const needed = Math.ceil(encodedTitle.length / TITLE_CELL_LENGTH);
    const slots: number[] = [];
    let free = fullWidth ? toc.nextFreeFullWidthTitleSlot : toc.nextFreeTitleSlot;
    while (slots.length < needed) {
        if (free === 0) return false;
        if (slots.includes(free) || used.has(free)) {
            throw new Error(`UTOC free title chain is corrupted at cell ${free}`);
        }
        slots.push(free);
        free = cells[free].link;
    }

    slots.forEach((slot, i) => {
        const title = Array(TITLE_CELL_LENGTH).fill(0);
        encodedTitle.slice(i * TITLE_CELL_LENGTH, (i + 1) * TITLE_CELL_LENGTH).forEach((byte, j) => (title[j] = byte));
        cells[slot] = { title, link: i === slots.length - 1 ? 0 : slots[i + 1] };
    });
    map[trackNumber] = slots[0];
    if (fullWidth) {
        toc.nextFreeFullWidthTitleSlot = free;
    } else {
        toc.nextFreeTitleSlot = free;
    }
    return true;
}
