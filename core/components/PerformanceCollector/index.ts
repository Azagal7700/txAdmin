const modulename = 'PerformanceCollector';
import fsp from 'node:fs/promises';
import * as d3array from 'd3-array';
import consoleFactory from '@extras/console';
import type TxAdmin from '@core/txAdmin.js';
import { LogNodeHeapEventSchema, SSFileSchema, isSSLogDataType } from './perfSchemas';
import type { LogNodeHeapEventType, SSFileType, SSLogDataType, SSLogType, SSPerfBoundariesType, SSPerfCountsType } from './perfSchemas';
import { diffPerfs, fetchFxsMemory, fetchRawPerfData, perfCountsToHist } from './perfUtils';
import { optimizeStatsLog } from './statsLogOptimizer';
import { convars } from '@core/globalData';
import { ZodError } from 'zod';
import { PERF_DATA_BUCKET_COUNT, PERF_DATA_INITIAL_RESOLUTION, PERF_DATA_MIN_TICKS } from './statsConfigs';
const console = consoleFactory(modulename);


//Consts
const megabyte = 1024 * 1024;
const STATS_DATA_FILE_VERSION = 1;
const STATS_DATA_FILE_NAME = 'statsData.json';


/**
 * This module is reponsiple to collect many statistics from the server.
 * Most of those will be displayed on the Dashboard.
 */
export default class PerformanceCollector {
    readonly #txAdmin: TxAdmin;
    private readonly statsDataPath: string;
    private statsLog: SSLogType = [];
    private lastFxsMemory: number | undefined;
    private lastNodeMemory: { used: number, total: number } | undefined;
    private lastPerfBoundaries: SSPerfBoundariesType | undefined;
    private lastPerfCounts: SSPerfCountsType | undefined;
    private lastPerfSaved: {
        ts: number,
        counts: SSPerfCountsType,
    } | undefined;

    constructor(txAdmin: TxAdmin) {
        this.#txAdmin = txAdmin;
        this.statsDataPath = `${txAdmin.info.serverProfilePath}/data/${STATS_DATA_FILE_NAME}`;
        this.loadStatsHistory();

        //Cron functions
        setInterval(() => {
            this.collectStats().catch((error) => {
                console.verbose.warn('Error while collecting server stats.');
                console.verbose.dir(error);
            });
        }, 60 * 1000);
    }


    /**
     * Reset the last perf data except boundaries
     */
    resetPerfState() {
        this.lastPerfCounts = undefined;
        this.lastPerfSaved = undefined;
    }


    /**
     * Reset the last perf data except boundaries
     */
    resetMemoryState() {
        this.lastNodeMemory = undefined;
        this.lastFxsMemory = undefined;
    }


    /**
     * Registers that fxserver has BOOTED (healthMonitor is ONLINE)
     */
    logServerBoot(bootTime: number) {
        this.resetPerfState();
        this.resetMemoryState();
        //If last log is a boot, remove it as the server didn't really start 
        // otherwise it would have lived long enough to have stats logged
        if (this.statsLog.length && this.statsLog.at(-1)!.type === 'svBoot') {
            this.statsLog.pop();
        }
        this.statsLog.push({
            ts: Date.now(),
            type: 'svBoot',
            bootTime,
        });
        this.saveStatsHistory();
    }


    /**
     * Registers that fxserver has CLOSED (fxRunner killing the process)
     */
    logServerClose(reason: string) {
        this.resetPerfState();
        this.resetMemoryState();
        if (this.statsLog.length) {
            if (this.statsLog.at(-1)!.type === 'svClose') {
                //If last log is a close, skip saving a new one
                return;
            } else if (this.statsLog.at(-1)!.type === 'svBoot') {
                //If last log is a boot, remove it as the server didn't really start
                this.statsLog.pop();
                return;
            }
        }
        this.statsLog.push({
            ts: Date.now(),
            type: 'svClose',
            reason,
        });
        this.saveStatsHistory();
    }


    /**
     * Stores the last server Node.JS memory usage for later use in the data log 
     */
    logServerNodeMemory(payload: LogNodeHeapEventType) {
        const validation = LogNodeHeapEventSchema.safeParse(payload);
        if (!validation.success) {
            console.verbose.warn('Invalid LogNodeHeapEvent payload:');
            console.verbose.dir(validation.error.errors);
            return;
        }
        this.lastNodeMemory = {
            used: parseFloat((payload.heapUsed / megabyte).toFixed(2)),
            total: parseFloat((payload.heapTotal / megabyte).toFixed(2)),
        };
    }


    /**
     * Get recent stats
     */
    getRecentStats() {
        return {
            joinLeaveTally30m: this.#txAdmin.playerlistManager.joinLeaveTally,
            fxsMemory: this.lastFxsMemory,
            nodeMemory: this.lastNodeMemory,
            perf: this.lastPerfCounts ? perfCountsToHist(this.lastPerfCounts) : undefined,
        }
    }


    /**
     * Cron function to collect all the stats and save it to the cache file
     */
    async collectStats() {
        //Precondition checks
        if (this.#txAdmin.fxRunner.fxChild === null) return;
        if (this.#txAdmin.playerlistManager === null) return;
        if (this.#txAdmin.healthMonitor.currentStatus !== 'ONLINE') return;

        //Get performance data
        const fxServerHost = (convars.debugExternalStatsSource)
            ? convars.debugExternalStatsSource
            : this.#txAdmin.fxRunner.fxServerHost;
        if (typeof fxServerHost !== 'string' || !fxServerHost) {
            throw new Error(`Invalid fxServerHost: ${fxServerHost}`);
        }

        //Fetch data
        const [fetchRawPerfDataRes, fetchFxsMemoryRes] = await Promise.allSettled([
            fetchRawPerfData(fxServerHost),
            fetchFxsMemory(),
        ]);
        if (fetchFxsMemoryRes.status === 'fulfilled') {
            this.lastFxsMemory = fetchFxsMemoryRes.value;
        }
        if (fetchRawPerfDataRes.status === 'rejected') throw fetchRawPerfDataRes.reason;
        const { perfBoundaries, perfMetrics } = fetchRawPerfDataRes.value;

        //Check for min tick count
        if (
            perfMetrics.svMain.count < PERF_DATA_MIN_TICKS ||
            perfMetrics.svNetwork.count < PERF_DATA_MIN_TICKS ||
            perfMetrics.svSync.count < PERF_DATA_MIN_TICKS
        ) {
            console.verbose.warn('Not enough ticks to log. Skipping this collection.');
            return;
        }

        //Check if first collection, boundaries changed
        if (!this.lastPerfCounts || !this.lastPerfSaved || !this.lastPerfBoundaries) {
            console.verbose.debug('First perf collection.');
            this.lastPerfBoundaries = perfBoundaries;
            this.resetPerfState();
        } else if (JSON.stringify(perfBoundaries) !== JSON.stringify(this.lastPerfBoundaries)) {
            console.warn('Performance boundaries changed. Resetting history.');
            this.statsLog = [];
            this.lastPerfBoundaries = perfBoundaries;
            this.resetPerfState();
        }

        //Checking if the counter (somehow) reset
        if (this.lastPerfCounts && this.lastPerfCounts.svMain.count > perfMetrics.svMain.count) {
            console.warn('Performance counter reset. Resetting lastPerfCounts/lastPerfSaved.');
            this.resetPerfState();
        } else if (this.lastPerfSaved && this.lastPerfSaved.counts.svMain.count > perfMetrics.svMain.count) {
            console.warn('Performance counter reset. Resetting lastPerfSaved.');
            this.lastPerfSaved = undefined;
        }

        //Calculate the tick/time counts since last collection (1m ago)
        const latestPerfHist = perfCountsToHist(diffPerfs(perfMetrics, this.lastPerfCounts));
        this.lastPerfCounts = perfMetrics;

        //Check if enough time passed since last collection
        const now = Date.now();
        let perfHistToSave;
        if (!this.lastPerfSaved) {
            perfHistToSave = latestPerfHist;
        } else if (now - this.lastPerfSaved.ts >= PERF_DATA_INITIAL_RESOLUTION) {
            perfHistToSave = perfCountsToHist(diffPerfs(perfMetrics, this.lastPerfSaved.counts));
        }
        if (!perfHistToSave) {
            console.verbose.debug('Not enough time passed since last saved collection. Skipping save.');
            return;
        }

        //Update cache
        this.lastPerfSaved = {
            ts: now,
            counts: perfMetrics,
        };
        const currSnapshot: SSLogDataType = {
            ts: now,
            type: 'data',
            players: this.#txAdmin.playerlistManager.onlineCount,
            fxsMemory: this.lastFxsMemory ?? null,
            nodeMemory: this.lastNodeMemory?.used ?? null,
            perf: perfHistToSave,
        };
        this.statsLog.push(currSnapshot);
        console.verbose.ok(`Collected performance snapshot #${this.statsLog.length}`);

        //Save perf series do file
        await this.saveStatsHistory();
    }


    /**
     * Loads the stats database/cache/history
     */
    async loadStatsHistory() {
        try {
            const rawFileData = await fsp.readFile(this.statsDataPath, 'utf8');
            const fileData = JSON.parse(rawFileData);
            if (fileData?.version !== STATS_DATA_FILE_VERSION) throw new Error('invalid version');
            const statsData = SSFileSchema.parse(fileData);
            this.lastPerfBoundaries = statsData.lastPerfBoundaries;
            this.statsLog = statsData.log;
            this.resetPerfState();
            console.verbose.debug(`Loaded ${this.statsLog.length} performance snapshots from cache`);
            await optimizeStatsLog(this.statsLog);
        } catch (error) {
            if (error instanceof ZodError) {
                console.warn(`Failed to load ${STATS_DATA_FILE_NAME} due to invalid data.`);
                console.warn('Since this is not a critical file, it will be reset.');
            } else {
                console.warn(`Failed to load ${STATS_DATA_FILE_NAME} with message: ${(error as Error).message}`);
                console.warn('Since this is not a critical file, it will be reset.');
            }
        }
    }


    /**
     * Saves the stats database/cache/history
     */
    async saveStatsHistory() {
        try {
            await optimizeStatsLog(this.statsLog);
            const savePerfData: SSFileType = {
                version: STATS_DATA_FILE_VERSION,
                lastPerfBoundaries: this.lastPerfBoundaries,
                log: this.statsLog,
            };
            await fsp.writeFile(this.statsDataPath, JSON.stringify(savePerfData));
        } catch (error) {
            console.warn(`Failed to save ${STATS_DATA_FILE_NAME} with message: ${(error as Error).message}`);
        }
    }


    /**
     * Returns a summary of the collected data and returns.
     * NOTE: kinda expensive
     */
    getServerPerfSummary() {
        //Configs
        const minSnapshots = 36; //3h of data
        const tsScanWindowStart = Date.now() - 6 * 60 * 60 * 1000; //6h ago

        //that's short for cumulative buckets, if you thought otherwise, i'm judging you
        const cumBuckets = Array(PERF_DATA_BUCKET_COUNT).fill(0);
        let cumTicks = 0;

        //Processing each snapshot - then each bucket
        let totalSnapshots = 0;
        const players = [];
        const fxsMemory = [];
        const nodeMemory = []
        for (const log of this.statsLog) {
            if (log.ts < tsScanWindowStart) continue;
            if (!isSSLogDataType(log)) continue;
            if (log.perf.svMain.count < PERF_DATA_MIN_TICKS) continue;
            totalSnapshots++
            players.push(log.players);
            fxsMemory.push(log.fxsMemory);
            nodeMemory.push(log.nodeMemory);
            for (let bIndex = 0; bIndex < PERF_DATA_BUCKET_COUNT; bIndex++) {
                const tickCount = log.perf.svMain.freqs[bIndex] * log.perf.svMain.count;
                cumTicks += tickCount;
                cumBuckets[bIndex] += tickCount;
            }
        }

        //Checking if at least 12h of data
        if (totalSnapshots < minSnapshots) {
            return null; //not enough data for meaningful analysis
        }

        //Formatting Output
        return {
            snaps: totalSnapshots,
            freqs: cumBuckets.map(cumAvg => cumAvg / cumTicks),
            players: d3array.median(players),
            fxsMemory: d3array.median(fxsMemory),
            nodeMemory: d3array.median(nodeMemory),
        };
    }
};
