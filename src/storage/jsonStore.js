import fs from 'node:fs/promises';
import path from 'node:path';

function defaultClone(value) {
    return value;
}

export function createJsonStore({
    filePath,
    initialData = {},
    validateData,
    cloneData = defaultClone,
    revalidateCache = false,
} = {}) {
    if (!filePath || typeof filePath !== 'string') {
        throw new Error('[jsonStore] filePath is required.');
    }

    let writeQueue = Promise.resolve();
    let cache = null;
    let cacheMeta = null;

    async function ensureFileExists() {
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        try {
            await fs.access(filePath);
        } catch {
            await fs.writeFile(filePath, JSON.stringify(initialData, null, 2), 'utf8');
        }
    }

    async function getFileMeta() {
        await ensureFileExists();
        const stats = await fs.stat(filePath);
        return {
            size: stats.size,
            mtimeMs: stats.mtimeMs,
        };
    }

    function sameMeta(left, right) {
        if (!left || !right) return false;
        return left.size === right.size && left.mtimeMs === right.mtimeMs;
    }

    async function writeAtomically(data) {
        await ensureFileExists();
        const tempPath = `${filePath}.tmp`;
        await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
        await fs.rename(tempPath, filePath);
    }

    async function loadFromDisk() {
        await ensureFileExists();
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (validateData) {
            await validateData(parsed);
        }
        return parsed;
    }

    function setCache(next) {
        cache = next;
        return cache;
    }

    async function reloadFromDisk() {
        const parsed = await loadFromDisk();
        setCache(parsed);
        if (revalidateCache) {
            cacheMeta = await getFileMeta();
        }
        return cache;
    }

    async function load({ forceReload = false } = {}) {
        if (!forceReload && cache) {
            if (!revalidateCache) {
                return cache;
            }
            const currentMeta = await getFileMeta();
            if (sameMeta(cacheMeta, currentMeta)) {
                return cache;
            }
        }
        return reloadFromDisk();
    }

    function enqueueMutation(operation) {
        const run = writeQueue.then(operation, operation);
        writeQueue = run.then(() => undefined, () => undefined);
        return run;
    }

    async function mutate(mutator) {
        return enqueueMutation(async () => {
            const db = await load();
            const result = await mutator(db);
            const didChange = result?.didChange ?? true;
            if (didChange) {
                setCache(db);
                await writeAtomically(db);
                if (revalidateCache) {
                    cacheMeta = await getFileMeta();
                }
            }
            return result;
        });
    }

    return {
        ensureFileExists,
        writeAtomically,
        enqueueMutation,
        mutate,
        load,
        reloadFromDisk,
        setCache,
        getCached: () => cloneData(cache),
    };
}
