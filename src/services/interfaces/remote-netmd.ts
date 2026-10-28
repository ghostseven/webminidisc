import { getCellsForTitle, getRemainingCharactersForTitles, MDTrack } from 'netmd-js';
import { Logger } from 'netmd-js/dist/logger';
import { concatUint8Arrays } from 'netmd-js/dist/utils';
import { makeGetAsyncPacketIteratorOnWorkerThread } from 'netmd-js/dist/web-encrypt-worker';
import { asyncMutex } from '../../utils';
import { Capability, NetMDService, Group, Disc, Track, convertDiscToNJS, convertTrackToNJS, Codec, WireformatDict } from './netmd';
import Worker from 'netmd-js/dist/web-encrypt-worker?worker';

// The newest server API this client knows how to use. Servers older than revision 2
// don't report a revision and lack the newer endpoints (download, finalize, ...).
const CLIENT_API_REVISION = 2;

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

    private requireServerRevision(revision: number, feature: string) {
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

    private async getFromServer(path: string, parameters?: { [key: string]: any }, method: string = 'GET') {
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

    async factory() {
        return null;
    }
}
