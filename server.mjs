import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import nodeCrypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { ReadableStream, WritableStream } from 'node:stream/web';
import { WebSocketServer, WebSocket } from 'ws';

// ==========================================
// 1. WebCrypto MD5 Polyfill
// ==========================================
if (!globalThis.crypto) {
    globalThis.crypto = nodeCrypto.webcrypto;
}
const origDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
globalThis.crypto.subtle.digest = async function (algorithm, data) {
    const name = typeof algorithm === 'string' ? algorithm : algorithm?.name;
    if (name?.toUpperCase() === 'MD5') {
        const hash = nodeCrypto.createHash('md5').update(Buffer.from(data)).digest();
        return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
    }
    return origDigest(algorithm, data);
};

// ==========================================
// 2. Global WebSocket & Response 101 Polyfill
// ==========================================
globalThis.WebSocket = WebSocket;

const OrigResponse = globalThis.Response;
globalThis.Response = class Response extends OrigResponse {
    constructor(body, init) {
        if (init && init.status === 101) {
            super(null, { status: 200, headers: init.headers });
            Object.defineProperty(this, 'status', { value: 101 });
            if (init.webSocket) this.webSocket = init.webSocket;
            return;
        }
        super(body, init);
    }
};

// ==========================================
// 3. WebSocketPair & Cloudflare WebSocket Shim
// ==========================================
const asyncLocalStorage = new AsyncLocalStorage();

class CloudflareWebSocket extends EventEmitter {
    constructor(wsClient) {
        super();
        this.wsClient = wsClient;
        this.binaryType = 'arraybuffer';
    }

    get readyState() {
        return this.wsClient ? this.wsClient.readyState : WebSocket.CLOSED;
    }

    accept() {
        // No-op for server-side
    }

    send(data) {
        if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
            return new Promise((res, rej) => {
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength || data.length);
                this.wsClient.send(buf, (err) => err ? rej(err) : res());
            });
        }
    }

    close(code, reason) {
        if (this.wsClient) {
            this.wsClient.close(code, reason);
        }
    }

    addEventListener(type, listener) {
        this.on(type, listener);
    }

    removeEventListener(type, listener) {
        this.off(type, listener);
    }
}

globalThis.WebSocketPair = class WebSocketPair {
    constructor() {
        const store = asyncLocalStorage.getStore() || {};
        const wsClient = store.wsClient;
        const serverSock = new CloudflareWebSocket(wsClient);
        if (wsClient) {
            wsClient.on('message', (data) => {
                const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
                serverSock.emit('message', { data: ab });
            });
            wsClient.on('close', (code, reason) => {
                serverSock.emit('close', { code, reason: reason?.toString?.() || '' });
            });
            wsClient.on('error', (err) => {
                serverSock.emit('error', err);
            });
        }
        const clientSock = { fakeClient: true };
        this[0] = clientSock;
        this[1] = serverSock;
    }
};

// ==========================================
// 4. Native TCP Outbound Connector
// ==========================================
function createTcpSocket({ hostname, port }, init = {}) {
    let resolveOpened, rejectOpened;
    const opened = new Promise((res, rej) => { resolveOpened = res; rejectOpened = rej; });
    let resolveClosed, rejectClosed;
    const closed = new Promise((res, rej) => { resolveClosed = res; rejectClosed = rej; });

    let socket;
    if (init.secureTransport === 'on') {
        socket = tls.connect({ host: hostname, port: Number(port), rejectUnauthorized: false });
    } else {
        socket = net.createConnection({ host: hostname, port: Number(port) });
    }

    socket.on('connect', () => resolveOpened());
    socket.on('secureConnect', () => resolveOpened());
    socket.on('error', (err) => {
        rejectOpened(err);
        rejectClosed(err);
    });
    socket.on('close', () => resolveClosed());

    let streamClosed = false;
    const readable = new ReadableStream({
        start(controller) {
            socket.on('data', (chunk) => {
                controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            });
            socket.on('end', () => {
                if (!streamClosed) {
                    streamClosed = true;
                    try { controller.close(); } catch (e) {}
                }
            });
            socket.on('error', (err) => {
                if (!streamClosed) {
                    streamClosed = true;
                    try { controller.error(err); } catch (e) {}
                }
            });
        },
        cancel() {
            socket.destroy();
        }
    });

    const writable = new WritableStream({
        write(chunk) {
            return new Promise((res, rej) => {
                socket.write(Buffer.from(chunk), (err) => err ? rej(err) : res());
            });
        },
        close() {
            socket.end();
        },
        abort() {
            socket.destroy();
        }
    });

    return {
        opened,
        closed,
        readable,
        writable,
        close: () => socket.destroy()
    };
}

// ==========================================
// 5. Local KV Storage Adapter (Disk Persistence)
// ==========================================
function createDiskKV(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    return {
        async get(key) {
            const safeKey = key.replace(/[^a-zA-Z0-9_.-]/g, '_');
            const filePath = path.join(dataDir, safeKey);
            try {
                return await fs.promises.readFile(filePath, 'utf-8');
            } catch {
                return null;
            }
        },
        async put(key, value) {
            const safeKey = key.replace(/[^a-zA-Z0-9_.-]/g, '_');
            const filePath = path.join(dataDir, safeKey);
            await fs.promises.writeFile(filePath, String(value), 'utf-8');
        },
        async delete(key) {
            const safeKey = key.replace(/[^a-zA-Z0-9_.-]/g, '_');
            const filePath = path.join(dataDir, safeKey);
            try {
                await fs.promises.unlink(filePath);
            } catch {}
        }
    };
}

// ==========================================
// 6. No-TLS & Plain IP Subscription Transformer
// ==========================================
function transformSubToNoTls(text, port) {
    const trimmed = text.trim();
    const isBase64 = /^[A-Za-z0-9+/=\r\n]+$/.test(trimmed) && !trimmed.includes('vless://') && !trimmed.includes('proxies:');
    let raw = trimmed;
    if (isBase64) {
        try {
            raw = Buffer.from(trimmed, 'base64').toString('utf-8');
        } catch {
            raw = trimmed;
        }
    }

    if (raw.includes('vless://') || raw.includes('trojan://') || raw.includes('ss://')) {
        raw = raw
            .replace(/security=tls/g, 'security=none')
            .replace(/:(?:443|2053|2083|2087|2096|8443)(\?|#)/g, `:${port}$1`)
            .replace(/[?&]sni=[^&#]+/g, '');
        return isBase64 ? Buffer.from(raw).toString('base64') : raw;
    }

    if (raw.includes('proxies:')) {
        raw = raw
            .replace(/(\bport:\s*)\d+/g, `$1${port}`)
            .replace(/(\btls:\s*)true/gi, '$1false');
        return raw;
    }

    if (raw.includes('"outbounds"')) {
        raw = raw
            .replace(/("server_port":\s*)\d+/g, `$1${port}`)
            .replace(/("tls":\s*\{[^}]*"enabled":\s*)true/gi, '$1false');
        return raw;
    }

    return text;
}

// ==========================================
// 7. Main Server Entrypoint
// ==========================================
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.BIND_HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.resolve('./data');

const env = {
    ADMIN: process.env.ADMIN || 'admin888',
    UUID: process.env.UUID,
    KEY: process.env.KEY,
    HOST: process.env.HOST,
    PROXYIP: process.env.PROXYIP,
    URL: process.env.URL,
    DEBUG: process.env.DEBUG,
    KV: createDiskKV(DATA_DIR)
};

const worker = (await import('./_worker.js')).default;

const server = http.createServer(async (req, res) => {
    try {
        const clientHost = req.headers['host'] || '127.0.0.1';
        // Note: force https so _worker.js doesn't trigger 301 http->https redirection
        const url = new URL(req.url, `https://${clientHost}`);

        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
            if (v !== undefined) {
                if (Array.isArray(v)) {
                    for (const item of v) headers.append(k, item);
                } else {
                    headers.set(k, v);
                }
            }
        }

        const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
        let bodyStream = null;
        if (hasBody) {
            bodyStream = new ReadableStream({
                start(controller) {
                    req.on('data', chunk => controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
                    req.on('end', () => controller.close());
                    req.on('error', err => controller.error(err));
                }
            });
        }

        const clientIp = req.headers['x-forwarded-for']?.split(',')?.[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';
        headers.set('cf-connecting-ip', clientIp);

        const cfRequest = new Request(url.toString(), {
            method: req.method,
            headers,
            body: bodyStream,
            duplex: 'half'
        });

        cfRequest.cf = {
            colo: process.env.CF_COLO || 'HKG',
            asn: Number(process.env.CF_ASN || 13335),
            country: process.env.CF_COUNTRY || 'HK'
        };

        cfRequest.fetcher = {
            connect: createTcpSocket
        };

        const ctx = {
            waitUntil(promise) {
                promise.catch?.(e => console.error('[waitUntil error]', e));
            }
        };

        const cfResponse = await worker.fetch(cfRequest, env, ctx);

        const isTls = Boolean(req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https');
        const shouldApplyNoTls = process.env.NO_TLS === 'true' || (!isTls && process.env.NO_TLS !== 'false');

        res.statusCode = cfResponse.status;

        // Strip headers that must not be blindly forwarded from upstream fetch:
        // 1. content-encoding: Node.js global fetch automatically decompresses upstream bodies,
        //    leaving cfResponse.body uncompressed. Forwarding 'content-encoding: gzip' causes
        //    browsers to fail with net::ERR_CONTENT_DECODING_FAILED (blank screen).
        // 2. content-length: The original content-length is the compressed size (or may change),
        //    which causes truncation. Letting Node.js use chunked transfer encoding is safe.
        // 3. hop-by-hop headers: connection, keep-alive, transfer-encoding.
        // 4. strict-transport-security: must not be sent over plain HTTP/IP.
        const STRIP_HEADERS = new Set([
            'content-encoding',
            'content-length',
            'transfer-encoding',
            'connection',
            'keep-alive'
        ]);
        if (shouldApplyNoTls) {
            STRIP_HEADERS.add('strict-transport-security');
        }

        const setCookies = typeof cfResponse.headers.getSetCookie === 'function'
            ? cfResponse.headers.getSetCookie()
            : null;

        if (setCookies && setCookies.length > 0) {
            const processed = shouldApplyNoTls
                ? setCookies.map(c => c.replace(/;\s*Secure/gi, ''))
                : setCookies;
            res.setHeader('set-cookie', processed);
        }

        for (const [k, v] of cfResponse.headers.entries()) {
            const lower = k.toLowerCase();
            if (STRIP_HEADERS.has(lower)) continue;
            if (lower === 'set-cookie') {
                if (!setCookies || setCookies.length === 0) {
                    res.setHeader(k, shouldApplyNoTls ? v.replace(/;\s*Secure/gi, '') : v);
                }
                continue;
            }
            res.setHeader(k, v);
        }

        if (cfResponse.body) {
            if (shouldApplyNoTls && url.pathname.startsWith('/sub')) {
                const rawText = await cfResponse.text();
                const transformed = transformSubToNoTls(rawText, PORT);
                res.setHeader('content-length', Buffer.byteLength(transformed));
                res.end(transformed);
                return;
            }

            const reader = cfResponse.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(Buffer.from(value));
            }
        }
        res.end();
    } catch (err) {
        console.error('[HTTP Server Error]:', err);
        res.statusCode = 500;
        res.end('Internal Server Error: ' + err.message);
    }
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, async (wsClient) => {
        const clientHost = req.headers['host'] || '127.0.0.1';
        const url = new URL(req.url, `https://${clientHost}`);

        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
            if (v !== undefined) {
                if (Array.isArray(v)) {
                    for (const item of v) headers.append(k, item);
                } else {
                    headers.set(k, v);
                }
            }
        }
        headers.set('Upgrade', 'websocket');
        const clientIp = req.headers['x-forwarded-for']?.split(',')?.[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';
        headers.set('cf-connecting-ip', clientIp);

        const cfRequest = new Request(url.toString(), {
            method: req.method,
            headers
        });
        cfRequest.cf = {
            colo: process.env.CF_COLO || 'HKG',
            asn: Number(process.env.CF_ASN || 13335),
            country: process.env.CF_COUNTRY || 'HK'
        };
        cfRequest.fetcher = {
            connect: createTcpSocket
        };

        const ctx = {
            waitUntil(p) { p.catch?.(e => console.error('[WS waitUntil error]', e)); }
        };

        await asyncLocalStorage.run({ wsClient }, async () => {
            try {
                await worker.fetch(cfRequest, env, ctx);
            } catch (err) {
                console.error('[WS error]', err);
                wsClient.close();
            }
        });
    });
});

server.listen(PORT, HOST, () => {
    console.log(`====================================================`);
    console.log(`🚀 edgetunnel Server is running!`);
    console.log(`📡 Listening on: http://${HOST}:${PORT}`);
    console.log(`🔑 Admin Password: ${env.ADMIN}`);
    console.log(`💾 KV Storage Path: ${DATA_DIR}`);
    console.log(`🌐 Admin Panel: http://${HOST}:${PORT}/admin`);
    console.log(`====================================================`);
});

