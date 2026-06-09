import { GAME_TYPES } from '../constants/queues.js';

export function isAccountVisibleForGame(account, game) {
    const notifications = account?.notifications ?? {};
    if (game === GAME_TYPES.LOL) return notifications.lolAnnouncements !== false;
    if (game === GAME_TYPES.TFT) return notifications.tftAnnouncements !== false;
    return true;
}
