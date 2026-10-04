/**
 * annotationEngine.js — queries over the annotations decoders have produced (windowed for
 * drawing, paged for the data table, nearest-to-sample lookup). Adds methods to WS.engine.
 */
(function (WS) {
    'use strict';
    const { engine } = WS;
    const { annotationsInRange } = WS.annotations;


    function annotationsAtRow(id, row, start, end, minWidth, limit) {
        const all = (engine.decodedResult(id)?.anns || []).filter((a) => a.row === row);
        return annotationsInRange(all, start, end, minWidth, limit);
    }
    /** Page of raw (unmerged) annotations for the data table: { total, offset, items }. */
    function annotationPage(id, row, offset, limit) {
        const all = (engine.decodedResult(id)?.anns || []).filter((a) => a.row === row);
        return { total: all.length, offset, items: all.slice(offset, offset + limit) };
    }
    /** Index of the annotation nearest `sampleIndex`, for click-to-focus from the waveform. */
    function annotationIndex(id, row, sampleIndex) {
        const all = (engine.decodedResult(id)?.anns || []).filter((a) => a.row === row);
        for (let i = 0; i < all.length; i++) {
            if (all[i].end >= sampleIndex) {
                return i;
            }
        }
        return Math.max(0, all.length - 1);
    }
    
    WS.annotations = Object.assign(WS.annotations || {}, { annotationsAtRow, annotationPage, annotationIndex });
})(window.WS = window.WS || {});
