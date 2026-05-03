# Rift Recap

A Discord bot built with **Node.js**, **discord.js**, and the **Riot Games API** that lets each server register Riot IDs, view rank data, and post automated match results.

## Current game-scope parity (TFT vs LoL)

### Shared (TFT + LoL)
- Account registration and server-scoped storage (`/register`, `/unregister`, `/list`)
- Rank snapshot display via `/rank` (with game filter support)
- Automated match-result posting from the polling service

### TFT-only today
- `/leaderboard`
- `/recap`
- `/recapconfig`
- Full recap-oriented helper pipeline and constants

### LoL boundaries today
- LoL data is supported for `/rank` and automated match-result posts.
- LoL does **not** yet have parity for leaderboard/recap command output.

## Features

### Riot ID Registration (Per Server)
- Register one or more Riot IDs to a Discord server.
- Data is isolated per server using Discord `guildId`.

### Rank Lookup
- `/rank` shows stored ranked snapshots for registered accounts.
- Supports **TFT**, **LoL**, or **both** via the `game` option.

### Persistent Storage
- Local JSON database at `./user_data/registrations.json`.
- Automatically creates `user_data/` and `registrations.json` if missing.
- Uses atomic writes (temp file + rename).

### Automated Match Tracking
- Polls each registered account's most recent TFT/LoL match ID.
- Detects new games via stored match cursors.
- Fetches match details + latest ranked snapshot.
- Computes LP deltas and posts game-specific embed summaries.

### Seasonal Reset Support
- `/resetranks confirm:true` clears TFT rank snapshots + recap history for the server.
- `/resetranks confirm:true before_date:YYYY-MM-DD` clears only accounts whose latest tracked TFT match occurred before that UTC date, then stores the cutoff for ongoing polling.
- `clear_match_cursor:true` can be used when you intentionally want a full cursor wipe.

## Backlog and status
### Near-term backlog
- Add optional per-game channel routing/filter presets (finer TFT vs LoL control).
- Add `/lastmatch` command for quick latest-match lookup.
- Add optional match-history browsing command flow.

### Known limitations
- Bot hosting/runtime operations are environment-dependent (24/7 hosting not bundled in this repo).
- No formal patch-notes/release changelog workflow is currently documented.
- `resetranks` edge-case behavior still needs explicit verification coverage (see verification tasks).

### Nice-to-have ideas
- Expanded release operations docs (deploy/update playbook).
- Broader historical analytics views beyond current recap output.

### Verification tasks
- Validate `/resetranks` behavior across:
  - server-wide reset,
  - date-scoped reset,
  - cursor-clear mode (`clear_match_cursor:true`),
  - mixed TFT+LoL registrations.

## Project structure
```text
src/
├── index.js
├── register-commands.js
├── config.js
├── riot.js
├── storage.js
├── commands/
│   ├── leaderboard.js
│   ├── list.js
│   ├── loadCommands.js
│   ├── rank.js
│   ├── recap.js
│   ├── recapconfig.js
│   ├── register.js
│   ├── resetRanks.js
│   ├── setchannel.js
│   └── unregister.js
├── constants/
│   ├── queues.js
│   ├── recap.js
│   └── regions.js
├── riot/
│   ├── api.js
│   ├── ddragon.js
│   └── ddragonIndexes.js
├── services/
│   ├── matchPoller.js
│   └── recapAutoPoster.js
├── storage/
│   └── normalize.js
└── utils/
    ├── autocomplete.js
    ├── lol.js
    ├── presentation.js
    ├── rankSnapshot.js
    ├── rateLimiter.js
    ├── recap.js
    ├── tft.js
    ├── unitStrip.js
    └── utils.js
```

## Configuration
Required environment variables:
- `DISCORD_BOT_TOKEN` — Discord bot token
- `RIOT_TFT_API_KEY` — Riot Games API key (TFT endpoints)
- `RIOT_LOL_API_KEY` — Riot Games API key (LoL endpoints)
Optional:

- `MATCH_POLL_INTERVAL_SECONDS` (default: 60)
- `MATCH_POLL_PER_ACCOUNT_DELAY_MS` (default: 250)
- `RECAP_AUTOPOST_HOUR` (default: 9)
- `RECAP_AUTOPOST_MINUTE` (default: 0)
# TODO
- Optional per-game channel routing/filter presets (finer TFT vs LoL control)
- LOOK INTO RESETRANKS IN MORE DEPTH*
- Host bot 24/7
- Patch notes / release changelog
- `/lastmatch` command
- Optional match history browsing

-----------------------------------------

# Progress
**Day 1: 1/22/2026**
- Discord bot created
- Riot API key refreshed daily for temporary use
- Basic node.js structure created
- Basic ping command created (/ping)
- Can fetch TFT Ranked profile summary (/rank)
- All commands need to be run manually, goal is to try automatic implementation soon

![Day 1 Progress](images/Rank_Day1_Progress.png)

**Day 2: 1/23/2026**
- Deciding on format of Discord embeds
- {Ranked/Double Up} {Victory/Defeat} for {gameName#tagLine}
- **Placement |   Rank   | {Win/Loss}**                        IMAGE?
-   1st-8th   |  D4 2LP  |  +- X LP
- Now stores registered users, need to update rank command to reflect this next
- Creates file if it didn't exist, updates atomically
- Changed platform/routing to just default to NA and to have a dropdown menu to reduce user error
Live Match Tracking
- Use league of graphs to embed the link for the match after it is finished
- Data dragon can embed some image, maybe their little legend?

![Day 2 Progress](images/Rank_Day2_Progress.png)

![Day 2 List Progress](images/List_Day2_Progress.png)

**Day 3: 1/24/2026**
- Rank command now supports dropdown, no more manual input
- Fixed issue with only one embed sending when user has ranked + double up to show
- League of graphs link shows on rank command
- Added an unregister command
- After a game, embed is sent in discord with a link to the LeagueOfGraphs page. WIP
- Keeping snapshots of last LP, last game id, etc to make this possible

![Day 3 Registration Progress](images/RegUnregister_Day3_Progress.png)
![Day 3 Tracker Progress](images/MatchTracking_Day3_Progress.png)

**Day 4: 1/25/2026**
- Fixed link structure for post game tracking
- Better updating json to track lp snapshots without error
- Plenty of redundant code is currently present at EOD, but functionality works. Next up, we trim the fat
- Operation works but is unstable

![Day 4 Tracker Progress](images/MatchTracking_Day4_Progress.png)

**Day 5: 1/26/2026**
- Match tracking fully functional and stable
- Improved match result embed design (Victory / Defeat cards)
- Fixed LP snapshot overwrites and async embed bugs
- Refactored polling to safely persist rank and match state
- System now stable enough for feature iteration and cleanup

![Day 5 Leaderboard Progress](images/Leaderboard_Day5_Progress.png)

**1/27/2026 - 2/6/2026**
- Recap columns only show either wins or losses, win column no longer shows negatives / zeros
- Update account info with rich information (include W/L/etc EVERYTIME)
- Autopost recap every morning at 9AM 
- Added command to config recap ```/recapconfig```
- Added LP standardization so that division changes are handled properly (IRON: 0, PLATINUM: 1600, MASTERS: 2800+)
- Various bug fixes
![Day 6 Leaderboard Progress](images/Leaderboard_Day6_Progress.png)
![Day 7 Recap Progress](images/Recap_Day7_Progress.png)

**2/7/2026 - 2/12/2026**
- 
