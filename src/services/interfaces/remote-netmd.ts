import { getCellsForTitle, getRemainingCharactersForTitles, MDTrack } from 'netmd-js';
import { Logger } from 'netmd-js/dist/logger';
import { concatUint8Arrays } from 'netmd-js/dist/utils';
import { makeGetAsyncPacketIteratorOnWorkerThread } from 'netmd-js/dist/web-encrypt-worker';
import { asyncMutex } from '../../utils';
import {
    Capability,
    NetMDService,
    NetMDFactoryService,
    ExploitCapability,
    Group,
    Disc,
    Track,
    convertDiscToNJS,
    convertTrackToNJS,
    Codec,
    WireformatDict,
    splitTrackInUTOC,
} from './netmd';
import { AtracRecoveryConfig } from 'netmd-exploits';
import { Mutex } from 'async-mutex';
import Worker from 'netmd-js/dist/web-encrypt-worker?worker';

// The newest server API this client knows how to use. Servers older than revision 2
// don't report a revision and lack the newer endpoints (download, finalize, ...).
// Revision 3 added the factory mode.
const CLIENT_API_REVISION = 3;

// The size of the binary messages data is sent to the server in
const WEBSOCKET_CHUNK_SIZE = 0x10000;

export class NetMDRemoteService extends NetMDService {
    private logger?: Logger;
    private server: string;
    private capabilities: Capability[] | null = null;
    private serverApiRevision = 1;
    private friendlyName: string;
    private useChunkedTransfersForLP: boolean;

    constructor({
        debug = false,
        serverAddress,
        friendlyName,
        useChunkedTransfersForLP = false,
    }: {
        debug: boolean;
        serverAddress: string;
        friendlyName: string;
        useChunkedTransfersForLP: boolean;
    }) {
        super();
        if (debug) {
            // Logging a few methods that have been causing issues with some units
            const _fn = (...args: any) => {
                if (args && args[0] && args[0].method) {
                    console.log(...args);
                }
            };
            this.logger = {
                debug: _fn,
                info: _fn,
                warn: _fn,
                error: _fn,
                child: () => this.logger!,
            };
        }
        this.server = serverAddress.endsWith('/') ? serverAddress.substring(0, serverAddress.length - 1) : serverAddress;
        this.friendlyName = friendlyName;
        this.useChunkedTransfersForLP = useChunkedTransfersForLP;
    }

    getRemainingCharactersForTitles(disc: Disc) {
        return getRemainingCharactersForTitles(convertDiscToNJS(disc));
    }

    getCharactersForTitle(track: Track) {
        const { halfWidth, fullWidth } = getCellsForTitle(convertTrackToNJS(track));
        return {
            halfWidth: halfWidth * 7,
            fullWidth: fullWidth * 7,
        };
    }

    isDeviceConnected(){
        return false;
    }

    private async fetchServerCapabilities() {
        const serverInfo = await this.getFromServer('', { client: CLIENT_API_REVISION });
        if (serverInfo.version !== '1.0') {
            throw new Error(`The Remote NetMD server is on an unsupported version (${serverInfo.version})`);
        }
        this.serverApiRevision = serverInfo.apiRevision ?? 1;
        this.capabilities = serverInfo.capabilities
            .map((n: keyof typeof Capability) => Capability[n])
            .filter((n: Capability | undefined) => n !== undefined);
    }

    requireServerRevision(revision: number, feature: string) {
        if (this.serverApiRevision < revision) {
            throw new Error(`${feature} requires a newer version of the Remote NetMD server`);
        }
    }

    async getServiceCapabilities() {
        if (this.capabilities === null) {
            await this.fetchServerCapabilities();
        }
        return this.capabilities!;
    }

    async pair() {
        await this.fetchServerCapabilities();
        return true;
    }

    async connect() {
        return false;
    }

    async getFromServer(path: string, parameters?: { [key: string]: any }, method: string = 'GET') {
        let jsonData;
        try {
            const url = new URL(`${this.server}/${path}`);
            let body = undefined;
            let headers = {};
            if (parameters) {
                for (const key in parameters) {
                    if (parameters[key] === undefined) delete parameters[key];
                }
            }
            if (method === 'GET') {
                url.search = new URLSearchParams(parameters).toString();
            } else {
                body = JSON.stringify(parameters);
                headers = {
                    'Content-Type': 'application/json',
                };
            }
            jsonData = await (await fetch(url.toString(), { method, body, headers })).json();
        } catch (ex) {
            this.logger?.error({ method: 'GENERIC', ex });
            throw new Error(`Cannot reach the Remote NetMD server at ${this.server}`);
        }
        if (!jsonData.ok) {
            this.logger?.error({ method: path, jsonData });
            throw new Error(`Remote NetMD: ${typeof jsonData.error === 'string' ? jsonData.error : `${path || 'connect'} failed`}`);
        }
        return jsonData.value;
    }

    @asyncMutex
    async listContent(flushCache?: boolean) {
        return await this.getFromServer('listContent', { flushCache: !!flushCache });
    }

    @asyncMutex
    async getDeviceStatus() {
        return await this.getFromServer('deviceStatus');
    }

    @asyncMutex
    async getDeviceName() {
        return (await this.getFromServer('deviceName')) + (this.friendlyName && ` (${this.friendlyName})`);
    }

    @asyncMutex
    async finalize() {
        this.requireServerRevision(2, 'Finalizing the disc');
        await this.getFromServer('finalize');
    }

    @asyncMutex
    async rewriteGroups(groups: Group[]) {
        return await this.getFromServer('rewriteGroups', { groups }, 'POST');
    }

    @asyncMutex
    async renameTrack(index: number, title: string, fullWidthTitle?: string) {
        return await this.getFromServer('renameTrack', { index, title, fullWidthTitle });
    }

    @asyncMutex
    async renameGroup(groupIndex: number, title: string, fullWidthTitle?: string) {
        return await this.getFromServer('renameGroup', { groupIndex, title, fullWidthTitle });
    }

    @asyncMutex
    async addGroup(groupBegin: number, groupLength: number, title: string, fullWidthTitle: string = '') {
        return await this.getFromServer('addGroup', { groupBegin, groupLength, title, fullWidthTitle });
    }

    @asyncMutex
    async deleteGroup(index: number) {
        return await this.getFromServer('deleteGroup', { index });
    }

    @asyncMutex
    async renameDisc(title: string, fullWidthTitle?: string) {
        return await this.getFromServer('renameDisc', { title, fullWidthTitle });
    }

    @asyncMutex
    async deleteTracks(indexes: number[]) {
        return await this.getFromServer('deleteTracks', { indexes }, 'POST');
    }

    @asyncMutex
    async wipeDisc() {
        return await this.getFromServer('wipeDisc');
    }

    @asyncMutex
    async ejectDisc() {
        await this.getFromServer('eject');
    }

    @asyncMutex
    async wipeDiscTitleInfo() {
        this.requireServerRevision(2, 'Wiping the disc titles');
        await this.getFromServer('wipeDiscTitleInfo');
    }

    @asyncMutex
    async formatToHiMD() {
        this.requireServerRevision(2, 'Formatting to Hi-MD');
        await this.getFromServer('formatToHiMD');
    }

    @asyncMutex
    async moveTrack(src: number, dst: number, updateGroups?: boolean) {
        return await this.getFromServer('moveTrack', { src, dst, updateGroups });
    }

    async prepareUpload() {
        await this.getFromServer('prepareUpload');
    }
    async finalizeUpload() {
        await this.getFromServer('finalizeUpload');
    }

    @asyncMutex
    upload(
        title: string,
        fullWidthTitle: string,
        data: ArrayBuffer,
        _format: Codec,
        progressCallback: (progress: { written: number; encrypted: number; total: number }) => void
    ) {
        return new Promise<void>((res, rej) => {
            let format;
            switch(_format.codec) {
                default:
                    throw new Error(`Remote NetMD does not currently support the codec ${_format.codec}`);
                case 'AT3':
                    format = { codec: _format.bitrate === 66 ? 'LP4' : 'LP2' };
                    break;
                case 'SPS':
                    format = { codec: 'SP' };
                    break;
                case 'SPM':
                    this.requireServerRevision(2, 'Mono SP uploads');
                    format = { codec: 'SPM' };
                    break;
            }
            const wsURL = this.getWebSocketURL('upload');
            //Send file

            const total = data.byteLength;
            let encrypted = 0;
            let written = 0;

            const updateProgress = () =>
                progressCallback({
                    written,
                    total,
                    encrypted,
                });

            const w = new Worker();

            const webWorkerAsyncPacketIterator = makeGetAsyncPacketIteratorOnWorkerThread(w, ({ encryptedBytes }) => {
                encrypted = encryptedBytes;
                updateProgress();
            });

            // A dud track used for the encryption. Mono SP is sent as PCM, like stereo SP.
            const track = new MDTrack('', WireformatDict[format.codec === 'SPM' ? 'SP' : format.codec], data, 0x400, '', webWorkerAsyncPacketIterator);
            const codec = format.codec.toString();
            wsURL.search = new URLSearchParams({
                title,
                fullWidthTitle,
                format: codec,
                totalLength: total.toString(),
                chunked: (this.useChunkedTransfersForLP && format.codec !== 'SP').toString(),
            }).toString();
            const ws = new WebSocket(wsURL.toString());
            let finished = false;

            ws.addEventListener('message', async event => {
                const json = JSON.parse(event.data);
                if (json.error) {
                    finished = true;
                    w.terminate();
                    ws.close();
                    rej(new Error(`Remote NetMD: ${json.error}`));
                } else if (json.init) {
                    // Read and encrypt the file
                    // Send the results of the encryption iterator to the server
                    for await (const piece of track.getPacketWorkerIterator()) {
                        // Serialize the piece
                        const combined = concatUint8Arrays(new Uint8Array([0]), piece.iv, piece.key, piece.data);
                        ws.send(combined);
                    }
                    ws.send(new Uint8Array([1]));
                    w.terminate();
                } else if (json.terminate) {
                    finished = true;
                    ws.close();
                    res();
                } else {
                    written = json.written;
                    updateProgress();
                }
            });

            ws.addEventListener('close', () => {
                w.terminate();
                if (!finished) rej(new Error('Remote NetMD: the connection was closed before the upload finished'));
            });
        });
    }

    private getWebSocketURL(path: string) {
        const servURL = new URL(this.server);
        const pathPrefix = servURL.pathname.endsWith('/') ? servURL.pathname : `${servURL.pathname}/`;
        return new URL(`${servURL.protocol === 'https:' ? 'wss:' : 'ws:'}//${servURL.host}${pathPrefix}${path}`);
    }

    // Runs one of the server's factory mode transfers (see `factoryWebSocket` in the server).
    // Resolves to the value the server finished with and the binary messages that followed it.
    factoryTransfer(
        path: string,
        parameters: { [key: string]: string },
        {
            payload,
            onProgress,
            onQuestion,
            shouldCancel,
        }: {
            payload?: Uint8Array;
            onProgress?: (progress: any) => void;
            onQuestion?: (question: any) => Promise<any>;
            shouldCancel?: () => boolean;
        } = {}
    ) {
        return new Promise<{ value: any; buffers: ArrayBuffer[] }>((res, rej) => {
            const wsURL = this.getWebSocketURL(path);
            wsURL.search = new URLSearchParams(parameters).toString();
            const ws = new WebSocket(wsURL.toString());
            ws.binaryType = 'arraybuffer';
            let value: any = null;
            let expectedBuffers = -1;
            const buffers: ArrayBuffer[] = [];
            let finished = false;
            let cancelSent = false;
            const finish = (callback: () => void) => {
                finished = true;
                ws.close();
                callback();
            };

            ws.addEventListener('open', () => {
                if (!payload) return;
                for (let i = 0; i < payload.length; i += WEBSOCKET_CHUNK_SIZE) {
                    ws.send(payload.subarray(i, i + WEBSOCKET_CHUNK_SIZE));
                }
                ws.send(JSON.stringify({ end: true }));
            });

            ws.addEventListener('message', async event => {
                if (event.data instanceof ArrayBuffer) {
                    buffers.push(event.data);
                    if (buffers.length === expectedBuffers) finish(() => res({ value, buffers }));
                    return;
                }
                const json = JSON.parse(event.data);
                if (json.error) {
                    finish(() => rej(new Error(`Remote NetMD: ${json.error}`)));
                } else if ('done' in json) {
                    value = json.done;
                    expectedBuffers = json.buffers;
                    if (expectedBuffers === 0) finish(() => res({ value, buffers }));
                } else if (json.question) {
                    const answer = await onQuestion!(json.question);
                    ws.send(JSON.stringify({ answer }));
                } else if (json.progress) {
                    onProgress?.(json.progress);
                    if (!cancelSent && shouldCancel?.()) {
                        cancelSent = true;
                        ws.send(JSON.stringify({ cancel: true }));
                    }
                }
            });

            ws.addEventListener('close', () => {
                if (!finished) rej(new Error('Remote NetMD: the connection was closed before the transfer finished'));
            });
        });
    }

    @asyncMutex
    download(index: number, progressCallback: (progress: { read: number; total: number }) => void) {
        this.requireServerRevision(2, 'Downloading tracks');
        return new Promise<{ extension: string; data: Uint8Array<ArrayBuffer> }>((res, rej) => {
            const wsURL = this.getWebSocketURL('download');
            wsURL.search = new URLSearchParams({ index: index.toString() }).toString();
            const ws = new WebSocket(wsURL.toString());
            ws.binaryType = 'arraybuffer';
            let extension: string | null = null;
            let finished = false;

            ws.addEventListener('message', event => {
                if (event.data instanceof ArrayBuffer) {
                    // The file itself, sent after its description
                    finished = true;
                    ws.close();
                    res({ extension: extension ?? 'wav', data: new Uint8Array(event.data) });
                    return;
                }
                const json = JSON.parse(event.data);
                if (json.error) {
                    finished = true;
                    ws.close();
                    rej(new Error(`Remote NetMD: ${json.error}`));
                } else if (json.extension) {
                    extension = json.extension;
                    progressCallback({ read: json.length, total: json.length });
                } else {
                    progressCallback({ read: json.read, total: json.total });
                }
            });

            ws.addEventListener('close', () => {
                if (!finished) rej(new Error('Remote NetMD: the connection was closed before the download finished'));
            });
        });
    }

    @asyncMutex
    async play() {
        return await this.getFromServer('play');
    }
    @asyncMutex
    async pause() {
        return await this.getFromServer('pause');
    }
    @asyncMutex
    async stop() {
        return await this.getFromServer('stop');
    }
    @asyncMutex
    async next() {
        return await this.getFromServer('next');
    }
    @asyncMutex
    async prev() {
        return await this.getFromServer('prev');
    }

    @asyncMutex
    async gotoTrack(index: number) {
        return await this.getFromServer('goto', { index });
    }

    @asyncMutex
    async gotoTime(index: number, h: number, m: number, s: number, f: number) {
        return await this.getFromServer('gotoTime', { index, hour: h, minute: m, second: s, frame: f });
    }

    @asyncMutex
    async getPosition() {
        return await this.getFromServer('getPosition');
    }

    @asyncMutex
    async factory() {
        this.requireServerRevision(3, 'The homebrew mode');
        // The server stops the playback and enters the factory mode
        const { firmware, capabilities } = await this.getFromServer('factory/init');
        return new NetMDRemoteFactoryService(
            this,
            this.mutex,
            firmware,
            capabilities
                .map((n: keyof typeof ExploitCapability) => ExploitCapability[n])
                .filter((n: ExploitCapability | undefined) => n !== undefined)
        );
    }
}

// The exploits run on the server, this only forwards the calls to it.
class NetMDRemoteFactoryService implements NetMDFactoryService {
    constructor(
        private parent: NetMDRemoteService,
        public mutex: Mutex,
        private firmware: string,
        private capabilities: ExploitCapability[]
    ) {}

    async getExploitCapabilities() {
        return this.capabilities;
    }

    async getDeviceFirmware() {
        return this.firmware;
    }

    private async readSector(index: number) {
        return new Uint8Array(await this.parent.getFromServer('factory/readUTOCSector', { index }));
    }

    private async writeSector(index: number, data: Uint8Array) {
        await this.parent.getFromServer('factory/writeUTOCSector', { index, data: Array.from(data) }, 'POST');
    }

    @asyncMutex
    async readUTOCSector(index: number) {
        return await this.readSector(index);
    }

    @asyncMutex
    async writeUTOCSector(index: number, data: Uint8Array) {
        await this.writeSector(index, data);
    }

    @asyncMutex
    async flushUTOCCacheToDisc() {
        await this.parent.getFromServer('factory/flushUTOC');
    }

    @asyncMutex
    async splitTrackForDAO(trackIndex: number, tracks: { weight: number; halfWidthTitle: string; fullWidthTitle: string }[]) {
        const untitled = await splitTrackInUTOC(
            (index) => this.readSector(index),
            (index, data) => this.writeSector(index, data),
            trackIndex,
            tracks
        );
        await this.parent.getFromServer('factory/flushUTOC');
        return untitled;
    }

    @asyncMutex
    async runTetris() {
        await this.parent.getFromServer('factory/runTetris');
    }

    @asyncMutex
    async readRAM(callback?: (progress: { readBytes: number; totalBytes: number }) => void) {
        const { buffers } = await this.parent.factoryTransfer('factory/readRAM', {}, { onProgress: callback });
        return new Uint8Array(buffers[0]);
    }

    @asyncMutex
    async readFirmware(callback: (progress: { type: 'RAM' | 'ROM' | 'DRAM'; readBytes: number; totalBytes: number }) => void) {
        const { value: parts, buffers } = await this.parent.factoryTransfer('factory/readFirmware', {}, { onProgress: callback });
        const firmware: { [part: string]: Uint8Array<ArrayBuffer> } = {};
        (parts as string[]).forEach((part, i) => (firmware[part] = new Uint8Array(buffers[i])));
        return firmware as { rom: Uint8Array<ArrayBuffer>; ram: Uint8Array<ArrayBuffer>; dram?: Uint8Array<ArrayBuffer> };
    }

    @asyncMutex
    async prepareDownload(useSlowerExploit: boolean) {
        const fellBack = await this.parent.getFromServer('factory/prepareDownload', { useSlowerExploit });
        if (fellBack) {
            alert('Slower exploit is not compatible with this device. Falling back to default');
        }
    }

    @asyncMutex
    async finalizeDownload() {
        await this.parent.getFromServer('factory/finalizeDownload');
    }

    @asyncMutex
    async exploitDownloadTrack(
        track: number,
        nerawDownload: boolean,
        callback: (data: { read: number; total: number; action: 'READ' | 'SEEK' | 'CHUNK'; sector?: string }) => void,
        config?: AtracRecoveryConfig
    ) {
        // The callbacks can't be serialized; they're answered over the WebSocket instead
        const { shouldCancelImmediately, handleBadSector, ...serializableConfig } = config ?? {};
        const { value, buffers } = await this.parent.factoryTransfer(
            'factory/downloadTrack',
            {
                track: track.toString(),
                neraw: nerawDownload.toString(),
                config: JSON.stringify(serializableConfig),
            },
            {
                onProgress: callback,
                shouldCancel: shouldCancelImmediately,
                onQuestion: async ({ badSector }) =>
                    handleBadSector ? await handleBadSector(badSector.address, badSector.count, badSector.seconds) : 'abort',
            }
        );
        return { data: new Uint8Array(buffers[0]), extension: value.extension as string };
    }

    @asyncMutex
    async setSPSpeedupActive(newState: boolean) {
        await this.parent.getFromServer('factory/setSPSpeedupActive', { enable: newState });
    }

    @asyncMutex
    async uploadSP(
        title: string,
        fullWidthTitle: string,
        mono: boolean,
        data: ArrayBuffer,
        progressCallback: (progress: { written: number; encrypted: number; total: number }) => void
    ) {
        // The server reshapes the data for the exploit and encrypts it, so it's sent as-is
        const { value: index } = await this.parent.factoryTransfer(
            'factory/uploadSP',
            { title, fullWidthTitle, mono: mono.toString() },
            { payload: new Uint8Array(data), onProgress: progressCallback }
        );
        return index as number;
    }

    @asyncMutex
    async enableHiMDFullMode() {
        await this.parent.getFromServer('factory/enableHiMDFullMode');
    }

    @asyncMutex
    async enableMonoUpload(enable: boolean) {
        await this.parent.getFromServer('factory/enableMonoUpload', { enable });
    }

    @asyncMutex
    async setDiscSwapDetection(enable: boolean) {
        await this.parent.getFromServer('factory/setDiscSwapDetection', { enable });
    }

    @asyncMutex
    async enterServiceMode() {
        await this.parent.getFromServer('factory/enterServiceMode');
    }
}
