/**
 * annotationEngine.js — queries over the annotations decoders have produced (windowed for
 * drawing, paged for the data table, nearest-to-sample lookup). Adds methods to WS.engine.
 */
(function (WS) {
    'use strict';
    const { engine } = WS;

    function annotationAtRow(id, row) {
        return (engine.decodedResult(id)?.anns || []).filter((a) => a.row??0 === row);
    }
    function annotationsAtRowInRange(id, row, start, end, minWidth, limit) {
        const allAtRow = annotationAtRow(id, row);
        return annotationsInRange(allAtRow, start, end, minWidth, limit);
    }
    /** Page of raw (unmerged) annotations for the data table: { total, offset, items }. */
    function annotationPage(id, row, offset, limit) {
        const allAtRow = annotationAtRow(id, row);
        return { total: allAtRow.length, offset, items: allAtRow.slice(offset, offset + limit) };
    }
    /** Index of the annotation nearest `sampleIndex`, for click-to-focus from the waveform. */
    function annotationIndex(id, row, sampleIndex) {
        const allAtRow = annotationAtRow(id, row);
        for (let i = 0; i < allAtRow.length; i++) {
            if (allAtRow[i].end >= sampleIndex) {
                return i;
            }
        }
        return Math.max(0, allAtRow.length - 1);
    }

    const { ANN } = WS.theme;

    /** Key for per-row annotation maps (decoder id + row). */
    function annKey(id, row) { return `${id}:${row}`; }

    /** The annotation (or merged block) covering `sample`, within `tolerance` samples; nearest wins. */
    function annotationAt(anns, sampleIndex, tolerance) {
        let best = null, bestDist = Infinity;
        for (const a of anns) {
            const dist = sampleIndex < a.start ? a.start - sampleIndex : sampleIndex > a.end ? sampleIndex - a.end : 0;
            if (dist <= tolerance && dist < bestDist) {
                best = a; bestDist = dist;
                if (dist === 0) break;
            }
        }
        return best;
    }

    /** View-windowed annotations, merging runs too dense to read into one DENSE block. */
    function annotationsInRange(all, start, end, minWidth, limit) {
        const visible = all.filter((a) => a.end >= start && a.start <= end);
        const out = [];
        let i = 0;
        while (i < visible.length && out.length < limit) {
            const a = visible[i];
            if (a.end - a.start >= minWidth) { out.push(a); i++; continue; }
            let j = i, groupEnd = a.end;
            while (j + 1 < visible.length && visible[j + 1].start - groupEnd < minWidth) { j++; groupEnd = visible[j].end; }
            if (j > i) { out.push({ start: a.start, end: groupEnd, row: a.row??0, class: ANN.DENSE, text: '' }); i = j + 1; }
            else { out.push(a); i++; }
        }
        return out;
    }
    
    WS.annotations = Object.assign(WS.annotations || {}, { 
        annKey, 
        annotationAt, 
        annotationsAtRowInRange, 
        annotationPage, 
        annotationIndex
    });
})(window.WS = window.WS || {});
