# Live Game Detection Outline/Progress 

## 1) Riot endpoints for active-game detection (LoL vs TFT)

PRIORITIZE LEAGUE FIRST, TFT CAN BE DONE LATER. LOWER PRIORITY.
### League of Legends
- Riot's API catalog currently lists `spectator-v5` for League of Legends.
- Historically, active-game lookups were done via spectator endpoints (e.g., "active game by summoner").
- For this codebase, LoL active-game support is **not implemented yet** in `src/riot/api.js`.

### Teamfight Tactics
- Riot's API catalog currently lists `spectator-tft-v5` for Teamfight Tactics.
- This strongly suggests TFT now has a first-party spectator/active-game surface (as of the current catalog).
- For this codebase, TFT active-game support is also **not implemented yet** in `src/riot/api.js`.

> Practical takeaway: both games now appear to have spectator API families in the catalog (`spectator-v5`, `spectator-tft-v5`), but we still need a quick implementation spike against the endpoint reference to confirm exact request/response contracts and permissions.

## 2) Required identifiers per endpoint (PUUID vs encryptedSummonerId)

Current bot identity model:
- Registration stores only `puuid` per game namespace under `account.identity.{tft|lol}.puuid`.

Endpoint implications:
- Match + rank flows in this repo are already PUUID-based (`/match/*/by-puuid`, `/league/*/by-puuid`).
  - **LoL spectator-v5:** VERIFIED TO WORK WITH CURRENT PUUID
  - **TFT spectator-tft-v5:** Likely verified to work as well, but not certain until tested.

## 3) Rate-limit budget impact in `src/services/matchPoller.js`

## Current cadence/fan-out behavior
From poller config and loop behavior:
- Default tick interval: `MATCH_POLL_INTERVAL_SECONDS = 60`.
- Per-account delay: `max(MATCH_POLL_PER_ACCOUNT_DELAY_MS, ceil(intervalMs / totalAccounts))`.
- So each tick attempts to visit all registered accounts, spreading requests across the interval.
- Riot limiter currently configured as `perSecond: 20`, `perTwoMinutes: 100`.

## Current request profile (without active-game API)
Per enabled game/account per tick:
- At least one matchlist call (seed or unseen detection).
- Additional paged matchlist calls when backfilling unseen IDs.
- One match-detail call per unseen match ID.
- Rank refresh only when stale (default every 180 min).

This means baseline cost already scales with:
- total accounts across all guilds,
- enabled games per account (TFT/LoL),
- number of unseen matches since last tick.

## Added cost if active-game checks are introduced
If we add one spectator active-game probe per enabled game/account per tick:
- +1 request per (account, game) each cycle, worst-case.
- At 60s interval, rough steady-state add:
  - `N_accounts * enabledGamesPerAccount / minute` requests.

Examples (steady-state add only):
- 50 accounts, both games enabled (2): +100 req/min.
- 100 accounts, both games enabled: +200 req/min.

Given the internal limiter budget (`100 req / 2 min = 50 req/min`), unconditional per-account spectator polling would exceed budget quickly unless:
- cadence is increased,
- checks are sampled/throttled,
- only one game is checked,
- or active-game checks are event-driven (e.g., only after "recently active" signals from match history).

## 4) Decision matrix

| Condition | Implementation choice | Schema impact | Poller impact |
|---|---|---|---|
| TFT `spectator-tft-v5` supports active-game lookup with available IDs | Implement true live state (`in_game`) for TFT | Add only required IDs (if not PUUID) | Add throttled spectator checks (not per-account-per-minute by default) |
| TFT spectator exists but requires IDs we don't currently store | Implement live state **after** identity expansion + migration/backfill | Add encrypted ID fields under `account.identity.tft` | Stage rollout; limit query rate |
| TFT has no usable active-game lookup for our auth/key tier | Implement `pending/awaiting_result` via match-history heuristics only | No required schema change | No new API family; keep current match polling + heuristic state machine |

## Recommended path for this repo
0. PRIORITIZE LOL SPECTATOR SETUP. TFT IS LOWER PRIORITY. 
1. Run a short endpoint spike against Riot `spectator-v5` and `spectator-tft-v5` references to confirm required path params and key access level.
2. If TFT active lookup is usable, implement live-state with strong throttling (per-account cool-down + global budget guard).
3. If not usable, explicitly implement heuristic pending state from existing match-history flow ("possible in-progress" until new match result arrives).
