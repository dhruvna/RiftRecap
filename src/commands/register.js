import { SlashCommandBuilder } from 'discord.js';

import {
    getTFTMatch,
    getTFTRankByPuuid,
    getTFTMatchIdsByPuuid,
    getLolRankByPuuid,
    getLolMatchIdsByPuuid,
    getLolMatch,
    resolveRegion,
} from '../riot.js';

import { REGION_CHOICES } from '../constants/regions.js';

import {
    makeAccountKey,
    upsertGuildAccountInStore,
} from '../storage.js';
import { GAME_TYPES, LOL_QUEUE_TYPES, TFT_QUEUE_TYPES } from '../constants/queues.js';
import { getRegistrationSnapshot } from '../services/registrationSnapshot.js';
import { respondToCommandError, withGuildCommand } from '../utils/withGuildCommand.js';
import { respondWithAccountChoices } from '../utils/autocomplete.js';

export default {
    data: new SlashCommandBuilder()
        .setName('register')
        .setDescription('Register Riot ID in this server for future lookup')
        .addStringOption((opt) =>
            opt.setName('gamename').setDescription('Riot ID Gamename (before #)').setRequired(true)
        )
        .addStringOption((opt) =>
            opt.setName('tagline').setDescription('Riot ID Tagline (after #)').setRequired(true)
        )
        .addStringOption((opt) =>
            opt.setName('region').setDescription('Region like NA, EUW, KR').setRequired(true).addChoices(...REGION_CHOICES)
        )
        .addBooleanOption((opt) =>
            opt
                .setName('send_match_alerts')
                .setDescription('Whether this account should post live/match alerts (default: true)')
                .setRequired(false)
        ),
    
    async autocomplete(interaction) {
        try {
            await respondWithAccountChoices(interaction);
        } catch (err) {
            console.error('Error during register autocomplete:', err);
            return interaction.respond([]);
        }
    },

    execute: withGuildCommand(async (interaction, { guildId }) => {
        
        const gameName = interaction.options.getString('gamename', true);
        const tagLine = interaction.options.getString('tagline', true);
        const regionInput = interaction.options.getString('region', true);
        const sendMatchAlerts = interaction.options.getBoolean('send_match_alerts', false);

        const { platform, regional, region } = resolveRegion(regionInput);

        const tftSnapshot = await getRegistrationSnapshot({
                gameType: GAME_TYPES.TFT,
            regional,
            platform,
            gameName,
            tagLine,
            rankFetcher: getTFTRankByPuuid,
            matchIdsFetcher: getTFTMatchIdsByPuuid,
            matchFetcher: getTFTMatch,
            rankedQueues: new Set([
                TFT_QUEUE_TYPES.RANKED,
                TFT_QUEUE_TYPES.RANKED_DOUBLE_UP,
            ]),
            getMatchTimestamp: (match) => match?.info?.game_datetime ?? 0,
        });
        const lolSnapshot = await getRegistrationSnapshot({
            gameType: GAME_TYPES.LOL,
            regional,
            platform,
            gameName,
            tagLine,
            rankFetcher: getLolRankByPuuid,
            matchIdsFetcher: getLolMatchIdsByPuuid,
            matchFetcher: getLolMatch,
            rankedQueues: new Set([
                LOL_QUEUE_TYPES.RANKED_SOLO_DUO,
                LOL_QUEUE_TYPES.RANKED_FLEX,
            ]),
            getMatchTimestamp: (match) => {
                const gameEndTimestamp = Number(match?.info?.gameEndTimestamp ?? 0);
                if (Number.isFinite(gameEndTimestamp) && gameEndTimestamp > 0) return gameEndTimestamp;
                return Number(match?.info?.gameCreation ?? 0);
            },
        });
    
        const { account: tftAccount, ...tftState } = tftSnapshot;
        const { account: lolAccount, ...lolState } = lolSnapshot;

        const stored = {
            key: makeAccountKey({ gameName: tftAccount.gameName, tagLine: tftAccount.tagLine, platform }),
            gameName: tftAccount.gameName,
            tagLine: tftAccount.tagLine,
            region,
            platform,
            regional,
            identity: {
                tft: { puuid: tftAccount.puuid ?? null },
                lol: { puuid: lolAccount?.puuid ?? null },
            },
            trackedGames: {
                tft: {
                    enabled: true,
                    lastMatchId: tftState.lastMatchId,
                    lastMatchAt: tftState.lastMatchAt,
                    lastRankByQueue: tftState.lastRankByQueue,
                    recapEvents: [],
                },
                lol: {
                    enabled: true,
                    lastMatchId: lolState.lastMatchId,
                    lastMatchAt: lolState.lastMatchAt,
                    lastRankByQueue: lolState.lastRankByQueue,
                    recapEvents: [],
                },
            },
            notifications: {
                lolAnnouncements: sendMatchAlerts !== false,
                tftAnnouncements: sendMatchAlerts !== false,
            },
        };
        
        const outcome = await upsertGuildAccountInStore(guildId, stored);

        if (outcome.existed) {
            await interaction.editReply(`**${stored.gameName}#${stored.tagLine}** is already registered in this server.`);
            return;
        }
    
        await interaction.editReply(`Successfully registered **${stored.gameName}#${stored.tagLine}** for this server.`);
    }, {
        defer: true,
        ephemeral: true,
        commandName: 'register',
        onError: async (interaction, err) => {
            console.error(
                `[register] getAccountByRiotId failed status=${err?.status ?? 'unknown'} endpoint=${err?.endpoint ?? 'unknown'}`,
                err?.responseText ? { responseText: err.responseText } : err
            );
            await respondToCommandError(interaction, err, { commandName: 'register' });
        },
    }),
};
