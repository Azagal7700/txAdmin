import got from "@lib/got";
import { secsToShortestDuration } from "@lib/misc";
import bytes from "bytes";
import type { Response } from "got";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import type { MonitorIssuesArray, VerboseErrorData } from "./index";


/**
 * Class to easily check elapsed time.
 * Seconds precision, rounded down, consistent.
 */
export class Stopwatch {
    private readonly autoStart: boolean = false;
    private tsStart: number | null = null;

    constructor(autoStart?: boolean) {
        if (autoStart) {
            this.autoStart = true;
            this.restart();
        }
    }

    /**
     * Reset the stopwatch (stop and clear).
     */
    reset() {
        if (this.autoStart) {
            this.restart();
        } else {
            this.tsStart = null;
        }
    }

    /**
     * Start or restart the stopwatch.
     */
    restart() {
        this.tsStart = Date.now();
    }

    /**
     * Returns if the timer is over a certain amount of time.
     * Always false if not started.
     */
    isOver(secs: number) {
        const elapsed = this.elapsed;
        if (elapsed === Infinity) {
            return false;
        } else {
            return elapsed >= secs;
        }
    }

    /**
     * Returns true if the stopwatch is running.
     */
    get started() {
        return this.tsStart !== null;
    }

    /**
     * Returns the elapsed time in seconds or Infinity if not started.
     */
    get elapsed() {
        if (this.tsStart === null) {
            return Infinity;
        } else {
            const elapsedMs = Date.now() - this.tsStart;
            return Math.floor(elapsedMs / 1000);
        }
    }
}


/**
 * Exported enum
 */
export enum MonitorState {
    PENDING = 'PENDING',
    HEALTHY = 'HEALTHY',
    DELAYED = 'DELAYED',
    FATAL = 'FATAL',
}


/**
 * Class to easily check elapsed time.
 * Seconds precision, rounded down, consistent.
 */
export class HealthEventMonitor {
    private readonly swLastHealthyEvent = new Stopwatch();
    private firstHealthyEvent: number | undefined;

    constructor(
        private readonly delayLimit: number,
        private readonly fatalLimit: number,
    ) { }

    /**
     * Resets the state of the monitor.
     */
    public reset() {
        this.swLastHealthyEvent.reset();
        this.firstHealthyEvent = undefined;
    }

    /**
     * Register a successful event
     */
    public markHealthy() {
        this.swLastHealthyEvent.restart();
        this.firstHealthyEvent ??= Date.now();
    }

    /**
     * Returns the current status of the monitor.
     */
    public get status() {
        let state: MonitorState;
        if (!this.swLastHealthyEvent.started) {
            state = MonitorState.PENDING;
        } else if (this.swLastHealthyEvent.isOver(this.fatalLimit)) {
            state = MonitorState.FATAL;
        } else if (this.swLastHealthyEvent.isOver(this.delayLimit)) {
            state = MonitorState.DELAYED;
        } else {
            state = MonitorState.HEALTHY;
        }
        return {
            state,
            secsSinceLast: this.swLastHealthyEvent.elapsed,
            secsSinceFirst: this.firstHealthyEvent
                ? Math.floor((Date.now() - this.firstHealthyEvent) / 1000)
                : Infinity,
        }
    }
}

type HealthEventMonitorStatus = HealthEventMonitor['status'];


/**
 * Helper to get the time tags for error messages
 */
export const getMonitorTimeTags = (
    heartBeat: HealthEventMonitorStatus,
    healthCheck: HealthEventMonitorStatus,
    processUptime: number,
) => {
    const secs = (s: number) => Number.isFinite(s) ? secsToShortestDuration(s, { round: false }) : '--';
    const procTime = secsToShortestDuration(processUptime);
    const hbTime = secs(heartBeat.secsSinceLast);
    const hcTime = secs(healthCheck.secsSinceLast);
    return {
        simple: `(HB:${hbTime}|HC:${hcTime})`,
        withProc: `(P:${procTime}|HB:${hbTime}|HC:${hcTime})`,
    }
}


/**
 * Processes a MonitorIssuesArray and returns a clean array of strings.
 */
export const cleanMonitorIssuesArray = (issues: MonitorIssuesArray | undefined) => {
    if (!issues || !Array.isArray(issues)) return [];

    let cleanIssues: string[] = [];
    for (const issue of issues) {
        if (!issue) continue;
        if (typeof issue === 'string') {
            cleanIssues.push(issue);
        } else {
            cleanIssues.push(...issue.all.filter(Boolean));
        }
    }
    return cleanIssues;
}


/**
 * Helper class to organize monitor issues.
 */
export class MonitorIssue {
    private readonly infos: string[] = [];
    private readonly details: string[] = [];
    constructor(public title: string) { }
    setTitle(title: string) {
        this.title = title;
    }
    addInfo(info: string | undefined) {
        if (!info) return;
        this.infos.push(info);
    }
    addDetail(detail: string | undefined) {
        if (!detail) return;
        this.details.push(detail);
    }
    get all() {
        return [this.title, ...this.infos, ...this.details];
    }
}


/**
 * Do a HTTP GET to the /dynamic.json endpoint and parse the JSON response.
 */
export const fetchDynamicJson = async (
    netEndpoint: string,
    timeout: number
): Promise<FetchDynamicJsonError | FetchDynamicJsonSuccess> => {
    let resp: Response<string>;
    try {
        resp = await got.get({
            url: `http://${netEndpoint}/dynamic.json`,
            maxRedirects: 0,
            timeout: { request: timeout },
            retry: { limit: 0 },
            throwHttpErrors: false,
        });
    } catch (error) {
        return {
            success: false,
            error: `HealthCheck Request error: ${(error as any).message}`,
            debugData: {},
        };
    }

    //Precalculating error message
    const bodyCutoff = 512;
    const debugData = {
        URL: String(resp.url),
        Status: `${resp.statusCode} ${resp.statusMessage}`,
        Server: String(resp.headers['server']),
        Location: String(resp.headers['location']),
        ContentType: String(resp.headers['content-type']),
        ContentLength: String(resp.headers['content-length']),
        BodyLength: bytes(resp.body.length),
        Body: resp.body.length > bodyCutoff ? resp.body.slice(0, bodyCutoff) + '[...]' : resp.body,
    } as Record<string, string>;

    //Checking response status
    if (resp.statusCode !== 200) {
        return {
            success: false,
            error: `HealthCheck HTTP status: ${debugData.Status}`,
            debugData,
        }
    }

    //Parsing response
    if (typeof resp.body !== 'string') {
        return {
            success: false,
            error: `HealthCheck response body is not a string.`,
            debugData,
        }
    }
    if (!resp.body.length) {
        return {
            success: false,
            error: `HealthCheck response body is empty.`,
            debugData,
        }
    }
    if (resp.body.toLocaleLowerCase().includes('<html')) {
        return {
            success: false,
            error: `HealthCheck response body is HTML instead of JSON.`,
            debugData,
        }
    }
    let jsonData: any;
    try {
        jsonData = JSON.parse(resp.body);
    } catch (error) {
        return {
            success: false,
            error: `HealthCheck response body is not valid JSON.`,
            debugData,
        }
    }
    const schemaRes = dynamicJsonSchema.safeParse(jsonData);
    if (!schemaRes.success) {
        return {
            success: false,
            error: fromZodError(schemaRes.error, { prefix: 'HealthCheck JSON invalid data' }).message,
            debugData,
        }
    }

    return {
        success: true,
        data: schemaRes.data,
    };
}

const dynamicJsonSchema = z.object({
    clients: z.number().int().nonnegative(),
    hostname: z.string().optional(),
    gametype: z.string().optional(),
    mapname: z.string().optional(),
    iv: z.string().optional(),
    sv_maxclients: z.coerce.number().int().nonnegative().optional(),
});

type FetchDynamicJsonError = {
    success: false,
} & VerboseErrorData;
type FetchDynamicJsonSuccess = {
    success: true,
    data: z.infer<typeof dynamicJsonSchema>,
};
