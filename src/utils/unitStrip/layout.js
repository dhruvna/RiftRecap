const ITEM_ROW_RATIO = 0.3;
const PORTRAIT_ROW_RATIO = 1 - ITEM_ROW_RATIO;
export const STAR_ROW_HEIGHT = 16;
export const STAR_ICON_SIZE = 11;
export const STAR_ICON_SPACING = 3;

export function calculateUnitStripLayout(unitCount, traitCount, options) {
    const {
        tileSize,
        padding,
        columns,
        traitIconSize,
    } = options;

    const rows = Math.ceil(unitCount / columns);
    const cardWidth = tileSize;
    const contentHeight = Math.floor(tileSize * 1.25);
    const cardHeight = contentHeight + STAR_ROW_HEIGHT;
    const portraitHeight = Math.floor(contentHeight * PORTRAIT_ROW_RATIO);
    const itemRowHeight = contentHeight - portraitHeight;

    const unitGridWidth = columns * cardWidth + (columns + 1) * padding;
    const traitRowWidth = traitCount > 0
        ? traitCount * traitIconSize + (traitCount + 1) * padding
        : 0;

    const width = Math.max(unitGridWidth, traitRowWidth);
    const traitSectionHeight = traitCount > 0
        ? traitIconSize + padding * 2
        : 0;
    const height = rows * cardHeight + (rows + 1) * padding + traitSectionHeight;

    return {
        rows,
        cardWidth,
        contentHeight,
        cardHeight,
        portraitHeight,
        itemRowHeight,
        unitGridWidth,
        traitRowWidth,
        width,
        height,
        traitSectionHeight,
        unitGridOffsetX: Math.floor((width - unitGridWidth) / 2),
        traitRowOffsetX: 0, // traits are left-aligned within their section
        unitGridStartY: traitSectionHeight,
    };
}

export function getUnitCardPosition(index, layout, options) {
    const { columns, padding } = options;
    const col = index % columns;
    const row = Math.floor(index / columns);

    return {
        x: layout.unitGridOffsetX + padding + col * (layout.cardWidth + padding),
        y: layout.unitGridStartY + padding + row * (layout.cardHeight + padding),
    };
}
