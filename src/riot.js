export {
    resolveRegion,
    getAccountByRiotId,
    getTFTRankByPuuid,
    getTFTMatchIdsByPuuid,
    getTFTMatch,
    getLolRankByPuuid,
    getLolMatchIdsByPuuid,
    getLolMatch,
    getLolActiveGameByPuuid,
    getTftActiveGameByPuuid,
    getProfileUrl,
    getMatchUrl,
} from './riot/api.js';

export {
    getTftRegaliaThumbnailUrl,
} from './riot/ddragon.js';

export {
    getTftChampionImageById,
    getTftItemImageById,
    getTftTraitImageById,
    getLolChampionImagesByIds,
} from './riot/ddragonIndexes.js';
