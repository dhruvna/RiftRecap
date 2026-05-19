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
    upsertGuildAccountAndLinkPersonInStore,
} from '../storage.js';
import { GAME_TYPES, LOL_QUEUE_TYPES, TFT_QUEUE_TYPES } from '../constants/queues.js';
import { getRegistrationSnapshot } from '../services/registrationSnapshot.js';
import { respondToCommandError, withGuildCommand } from '../utils/withGuildCommand.js';
import { respondWithPersonChoices } from '../utils/autocomplete.js';

const PERSON_MODES = {
    NEW: 'new',
    EXISTING: 'existing',
};

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
        .addStringOption((opt) =>
            opt
                .setName('person_mode')
                .setDescription('Link this account to a new or existing person record')
                .setRequired(false)
                .addChoices(
                    { name: 'new', value: PERSON_MODES.NEW },
                    { name: 'existing', value: PERSON_MODES.EXISTING },
                )
        )
        .addStringOption((opt) =>
            opt
                .setName('person')
                .setDescription('Existing person to link when person_mode=existing')
                .setRequired(false)
                .setAutocomplete(true)
        )
        .addStringOption((opt) =>
            opt
                .setName('display_name')
                .setDescription('Display name to create when person_mode=new')
                .setRequired(false)
        )
        .addStringOption((opt) =>
            opt
                .setName('alias')
                .setDescription('Alias to create when person_mode=new (fallback for display_name)')
                .setRequired(false)
        )
        .addBooleanOption((opt) =>
            opt
                .setName('confirm_reassign')
                .setDescription('Required to reassign an already-linked account to another person')
                .setRequired(false)
        )
        .addBooleanOption((opt) =>
            opt
                .setName('send_match_alerts')
                .setDescription('Whether this account should post live/match alerts (default: true)')
                .setRequired(false)
        ),
    
    async autocomplete(interaction) {
        try {
            await respondWithPersonChoices(interaction, {
                modeOptionName: 'person_mode',
                expectedMode: PERSON_MODES.EXISTING,
            });
        } catch (err) {
            console.error('Error during register autocomplete:', err);
            return interaction.respond([]);
        }
    },

    execute: withGuildCommand(async (interaction, { guildId }) => {
        
        const gameName = interaction.options.getString('gamename', true);
        const tagLine = interaction.options.getString('tagline', true);
        const regionInput = interaction.options.getString('region', true);
        const personMode = interaction.options.getString('person_mode', false);
        const selectedPersonId = interaction.options.getString('person', false);
        const displayName = interaction.options.getString('display_name', false);
        const alias = interaction.options.getString('alias', false);
        const confirmReassign = interaction.options.getBoolean('confirm_reassign', false) === true;
        const sendMatchAlerts = interaction.options.getBoolean('send_match_alerts', false);
        let desiredPersonLink = null;
        let desiredDisplayName = null;

        if (personMode === PERSON_MODES.EXISTING) {
            if (!selectedPersonId) {
                await interaction.editReply('`person` is required when `person_mode` is `existing`.');
                return;
            }
            desiredPersonLink = { mode: PERSON_MODES.EXISTING, personId: selectedPersonId };
        } else if (personMode === PERSON_MODES.NEW) {
            desiredDisplayName = (displayName ?? alias ?? '').trim();
            if (!desiredDisplayName) {
                await interaction.editReply('`display_name` (or `alias`) is required when `person_mode` is `new`.');
                return;
            }
            desiredPersonLink = { mode: PERSON_MODES.NEW, displayName: desiredDisplayName };
        }

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

        const outcome = await upsertGuildAccountAndLinkPersonInStore(guildId, {
            account: stored,
            personLink: desiredPersonLink,
            allowReassign: confirmReassign,
        });

        // 6. Confirm to user
        if (outcome.reassignBlocked) {
            await interaction.editReply(
                'This account is already linked to a different person. Re-run with `confirm_reassign:true` to move it.'
            );
            return;
        }

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
