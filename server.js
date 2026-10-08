const express = require("express");
const cors = require("cors");
const yts = require("yt-search");
const youtubedl = require("youtube-dl-exec");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const app = express();

const PORT = Number(process.env.PORT) || 5000;

const API_KEY =
    process.env.VORTEX_API_KEY || "";

const MAX_CONCURRENT =
    Number(process.env.MAX_CONCURRENT) || 2;

/*
 * YouTube authentication.
 *
 * If you later upload a cookies.txt file to the server,
 * set YOUTUBE_COOKIES to its full path.
 *
 * Example:
 * YOUTUBE_COOKIES=/home/container/private/youtube-cookies.txt
 */
const YOUTUBE_COOKIES =
    process.env.YOUTUBE_COOKIES || "";

const DOWNLOAD_DIR =
    path.join(__dirname, "downloads");

if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, {
        recursive: true
    });
}

app.use(cors());

app.use(
    express.json({
        limit: "1mb"
    })
);

/* =========================
   STATE
========================= */

let activeDownloads = 0;

const rateMap = new Map();

const RATE_WINDOW =
    60 * 1000;

const RATE_LIMIT = 20;

/* =========================
   HELPERS
========================= */

function removeFile(file) {
    try {
        if (
            file &&
            fs.existsSync(file)
        ) {
            fs.unlinkSync(file);
        }
    } catch {}
}

function cleanupPrefix(prefix) {
    try {
        const files =
            fs.readdirSync(
                DOWNLOAD_DIR
            );

        for (const file of files) {
            if (
                file.startsWith(prefix)
            ) {
                removeFile(
                    path.join(
                        DOWNLOAD_DIR,
                        file
                    )
                );
            }
        }
    } catch {}
}

function isValidUrl(value) {
    try {
        const parsed =
            new URL(value);

        return (
            parsed.protocol === "http:" ||
            parsed.protocol === "https:"
        );
    } catch {
        return false;
    }
}

function isYouTubeUrl(value) {
    try {
        const hostname =
            new URL(value)
                .hostname
                .toLowerCase()
                .replace(/^www\./, "");

        return (
            hostname === "youtube.com" ||
            hostname === "m.youtube.com" ||
            hostname === "youtu.be" ||
            hostname === "music.youtube.com"
        );
    } catch {
        return false;
    }
}

function getClientIp(req) {
    return (
        req.headers[
            "x-forwarded-for"
        ]
            ?.split(",")[0]
            ?.trim() ||
        req.socket.remoteAddress ||
        "unknown"
    );
}

function rateLimit(
    req,
    res,
    next
) {
    const ip =
        getClientIp(req);

    const now =
        Date.now();

    const entry =
        rateMap.get(ip);

    if (
        !entry ||
        now - entry.start >
            RATE_WINDOW
    ) {
        rateMap.set(ip, {
            start: now,
            count: 1
        });

        return next();
    }

    if (
        entry.count >=
        RATE_LIMIT
    ) {
        return res.status(429).json({
            success: false,
            error:
                "Too many requests. Please try again later."
        });
    }

    entry.count++;

    next();
}

function requireApiKey(
    req,
    res,
    next
) {
    if (!API_KEY) {
        return next();
    }

    const provided =
        req.headers["x-api-key"] ||
        req.query.api_key;

    if (
        !provided ||
        provided !== API_KEY
    ) {
        return res.status(401).json({
            success: false,
            error:
                "Invalid or missing API key"
        });
    }

    next();
}

function acquireDownloadSlot(
    res
) {
    if (
        activeDownloads >=
        MAX_CONCURRENT
    ) {
        res.status(429).json({
            success: false,
            error:
                "Download server is busy. Please try again shortly."
        });

        return false;
    }

    activeDownloads++;

    return true;
}

function releaseDownloadSlot() {
    activeDownloads =
        Math.max(
            0,
            activeDownloads - 1
        );
}

function sendFileAndCleanup(
    res,
    file,
    filename,
    contentType,
    prefix
) {
    res.sendFile(
        file,
        {
            headers: {
                "Content-Type":
                    contentType,

                "Content-Disposition":
                    `attachment; filename="${filename}"`
            }
        },
        error => {
            if (error) {
                console.error(
                    "SEND ERROR:",
                    error.message
                );
            }

            cleanupPrefix(prefix);
        }
    );
}

function getQuality(value) {
    const allowed = [
        "360",
        "480",
        "720"
    ];

    if (!value) {
        return "720";
    }

    return allowed.includes(
        String(value)
    )
        ? String(value)
        : null;
}

/*
 * yt-dlp options shared by music/video.
 *
 * Node is used instead of Deno.
 *
 * EJS is enabled through the official
 * remote component mechanism.
 */
function getYoutubeOptions() {
    const options = {
        jsRuntimes: "node",

        remoteComponents:
            "ejs:github",

        noWarnings: true,

        noPlaylist: true
    };

    /*
     * Cookies are OPTIONAL.
     *
     * Nothing happens if YOUTUBE_COOKIES
     * is not configured.
     */
    if (
        YOUTUBE_COOKIES &&
        fs.existsSync(YOUTUBE_COOKIES)
    ) {
        options.cookies =
            YOUTUBE_COOKIES;

        console.log(
            "🍪 YouTube cookies: enabled"
        );
    }

    return options;
}

function resolveSearchQuery(
    query
) {
    return yts(query).then(
        result => {
            if (
                !result.videos ||
                !result.videos.length
            ) {
                throw new Error(
                    "No results found"
                );
            }

            return result.videos[0].url;
        }
    );
}

/* =========================
   GLOBAL MIDDLEWARE
========================= */

app.use(rateLimit);

app.use(requireApiKey);

/* =========================
   HOME
========================= */

app.get("/", (req, res) => {
    res.json({
        name:
            "VORTEX MEDIA API",

        version:
            "5.0.0",

        status:
            "online",

        runtime:
            "node",

        endpoints: {
            status:
                "/api/status",

            search:
                "/api/search?query=...",

            music:
                "/api/music?url=...",

            video:
                "/api/video?url=...&quality=720"
        }
    });
});

/* =========================
   STATUS
========================= */

app.get(
    "/api/status",
    (req, res) => {
        res.json({
            success: true,

            status:
                "online",

            version:
                "5.0.0",

            service:
                "VORTEX MEDIA API",

            runtime:
                "node",

            search:
                "ready",

            music:
                "ready",

            video:
                "ready",

            ffmpeg:
                "ready",

            youtubeRuntime:
                "node",

            ejs:
                "enabled",

            cookies:
                YOUTUBE_COOKIES &&
                fs.existsSync(
                    YOUTUBE_COOKIES
                )
                    ? "enabled"
                    : "disabled",

            activeDownloads,

            maxConcurrent:
                MAX_CONCURRENT,

            uptime:
                Math.floor(
                    process.uptime()
                )
        });
    }
);

/* =========================
   SEARCH
========================= */

app.get(
    "/api/search",
    async (req, res) => {
        try {
            const query =
                String(
                    req.query.query ||
                        ""
                ).trim();

            if (!query) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            "Missing query"
                    });
            }

            if (
                query.length > 200
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            "Query is too long"
                    });
            }

            console.log(
                "🔎 SEARCH:",
                query
            );

            const result =
                await yts(query);

            const videos =
                result.videos
                    .slice(0, 10)
                    .map(video => ({
                        title:
                            video.title,

                        url:
                            video.url,

                        duration:
                            video.timestamp,

                        seconds:
                            video.seconds,

                        views:
                            video.views,

                        author:
                            video.author
                                ?.name ||
                            null,

                        thumbnail:
                            video.thumbnail
                    }));

            res.json({
                success: true,
                query,
                results:
                    videos
            });

        } catch (error) {
            console.error(
                "SEARCH ERROR:",
                error.message
            );

            res.status(500).json({
                success: false,
                error:
                    "Search failed"
            });
        }
    }
);

/* =========================
   MUSIC
========================= */

app.get(
    "/api/music",
    async (req, res) => {
        if (
            !acquireDownloadSlot(
                res
            )
        ) {
            return;
        }

        const id =
            Date.now();

        const prefix =
            `audio-${id}`;

        const template =
            path.join(
                DOWNLOAD_DIR,
                `${prefix}.%(ext)s`
            );

        try {
            let url =
                String(
                    req.query.url ||
                        ""
                ).trim();

            const query =
                String(
                    req.query.query ||
                        ""
                ).trim();

            if (
                !url &&
                query
            ) {
                console.log(
                    "🎵 SEARCH MUSIC:",
                    query
                );

                url =
                    await resolveSearchQuery(
                        query
                    );
            }

            if (!url) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            "Missing url or query"
                    });
            }

            if (
                !isValidUrl(url)
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            "Invalid URL"
                    });
            }

            if (
                !isYouTubeUrl(url)
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            "Only YouTube URLs are supported"
                    });
            }

            console.log(
                "🎵 MUSIC:",
                url
            );

            const options =
                getYoutubeOptions();

            await youtubedl(
                url,
                {
                    ...options,

                    extractAudio:
                        true,

                    audioFormat:
                        "mp3",

                    audioQuality:
                        "0",

                    output:
                        template
                }
            );

            const output =
                path.join(
                    DOWNLOAD_DIR,
                    `${prefix}.mp3`
                );

            if (
                !fs.existsSync(
                    output
                )
            ) {
                throw new Error(
                    "Audio file was not created"
                );
            }

            console.log(
                "✔ MUSIC READY:",
                output
            );

            sendFileAndCleanup(
                res,
                output,
                "vortex-audio.mp3",
                "audio/mpeg",
                prefix
            );

        } catch (error) {
            console.error(
                "MUSIC ERROR:",
                error.message
            );

            cleanupPrefix(
                prefix
            );

            if (
                !res.headersSent
            ) {
                res.status(500).json({
                    success: false,
                    error:
                        "Music download failed"
                });
            }

        } finally {
            releaseDownloadSlot();
        }
    }
);

/* =========================
   VIDEO
========================= */

app.get(
    "/api/video",
    async (req, res) => {
        if (
            !acquireDownloadSlot(
                res
            )
        ) {
            return;
        }

        const id =
            Date.now();

        const prefix =
            `video-${id}`;

        const quality =
            getQuality(
                req.query.quality
            );

        if (!quality) {
            releaseDownloadSlot();

            return res
                .status(400)
                .json({
                    success: false,
                    error:
                        "Invalid quality. Use 360, 480, or 720."
                });
        }

        const template =
            path.join(
                DOWNLOAD_DIR,
                `${prefix}.%(ext)s`
            );

        const finalFile =
            path.join(
                DOWNLOAD_DIR,
                `${prefix}.mp4`
            );

        try {
            let url =
                String(
                    req.query.url ||
                        ""
                ).trim();

            const query =
                String(
                    req.query.query ||
                        ""
                ).trim();

            if (
                !url &&
                query
            ) {
                console.log(
                    "🎬 SEARCH VIDEO:",
                    query
                );

                url =
                    await resolveSearchQuery(
                        query
                    );
            }

            if (!url) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            "Missing url or query"
                    });
            }

            if (
                !isValidUrl(url)
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            "Invalid URL"
                    });
            }

            if (
                !isYouTubeUrl(url)
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            "Only YouTube URLs are supported"
                    });
            }

            console.log(
                `🎬 VIDEO ${quality}p:`,
                url
            );

            const options =
                getYoutubeOptions();

            await youtubedl(
                url,
                {
                    ...options,

                    format:
                        `bv*[ext=mp4][height<=${quality}]+ba[ext=m4a]/` +
                        `bv*[height<=${quality}]+ba/` +
                        `b[ext=mp4][height<=${quality}]/` +
                        `b[height<=${quality}]`,

                    mergeOutputFormat:
                        "mp4",

                    output:
                        template
                }
            );

            let output =
                finalFile;

            /*
             * Find merged MP4 if yt-dlp
             * generated a different name.
             */

            if (
                !fs.existsSync(
                    output
                )
            ) {
                const files =
                    fs.readdirSync(
                        DOWNLOAD_DIR
                    );

                const merged =
                    files.find(
                        file =>
                            file.startsWith(
                                `${prefix}.`
                            ) &&
                            file.endsWith(
                                ".mp4"
                            ) &&
                            !file.includes(
                                ".f"
                            )
                    );

                if (merged) {
                    output =
                        path.join(
                            DOWNLOAD_DIR,
                            merged
                        );
                }
            }

            /*
             * Manual FFmpeg fallback.
             */

            if (
                !fs.existsSync(
                    output
                )
            ) {
                const files =
                    fs.readdirSync(
                        DOWNLOAD_DIR
                    );

                const video =
                    files.find(
                        file =>
                            file.startsWith(
                                `${prefix}.`
                            ) &&
                            file.endsWith(
                                ".mp4"
                            )
                    );

                const audio =
                    files.find(
                        file =>
                            file.startsWith(
                                `${prefix}.`
                            ) &&
                            file.endsWith(
                                ".m4a"
                            )
                    );

                if (
                    !video ||
                    !audio
                ) {
                    throw new Error(
                        "Downloaded streams found, but video/audio merge files are missing"
                    );
                }

                const videoFile =
                    path.join(
                        DOWNLOAD_DIR,
                        video
                    );

                const audioFile =
                    path.join(
                        DOWNLOAD_DIR,
                        audio
                    );

                console.log(
                    "🔧 Merging video + audio with FFmpeg..."
                );

                await new Promise(
                    (
                        resolve,
                        reject
                    ) => {
                        const ffmpeg =
                            spawn(
                                "ffmpeg",
                                [
                                    "-y",

                                    "-i",
                                    videoFile,

                                    "-i",
                                    audioFile,

                                    "-c:v",
                                    "copy",

                                    "-c:a",
                                    "aac",

                                    "-movflags",
                                    "+faststart",

                                    output
                                ],
                                {
                                    stdio:
                                        "inherit"
                                }
                            );

                        ffmpeg.on(
                            "error",
                            reject
                        );

                        ffmpeg.on(
                            "close",
                            code => {
                                if (
                                    code ===
                                    0
                                ) {
                                    resolve();
                                } else {
                                    reject(
                                        new Error(
                                            `FFmpeg exited with code ${code}`
                                        )
                                    );
                                }
                            }
                        );
                    }
                );

                if (
                    !fs.existsSync(
                        output
                    )
                ) {
                    throw new Error(
                        "FFmpeg failed to create the final video"
                    );
                }
            }

            console.log(
                "✔ VIDEO READY:",
                output
            );

            sendFileAndCleanup(
                res,
                output,
                `vortex-video-${quality}p.mp4`,
                "video/mp4",
                prefix
            );

        } catch (error) {
            console.error(
                "VIDEO ERROR:",
                error.message
            );

            cleanupPrefix(
                prefix
            );

            if (
                !res.headersSent
            ) {
                res.status(500).json({
                    success: false,
                    error:
                        "Video download failed"
                });
            }

        } finally {
            releaseDownloadSlot();
        }
    }
);

/* =========================
   404
========================= */

/* =========================
   GENERIC SITE DOWNLOAD
========================= */

const SITE_HOSTS = ["facebook.com", "fb.com", "fb.watch", "instagram.com", "twitter.com", "x.com", "soundcloud.com", "pinterest.com", "pin.it", "tiktok.com"];
const PIN_RE = /(^|\.)pinterest\.[a-z.]+$/;
const MIME = { mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mp3: "audio/mpeg", m4a: "audio/mp4", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

function siteAllowed(value) {
    try {
        const h = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
        return SITE_HOSTS.some(d => h === d || h.endsWith("." + d)) || PIN_RE.test(h);
    } catch {
        return false;
    }
}

async function pinterestImage(url, prefix) {
    const page = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
    const host = new URL(page.url).hostname.toLowerCase();
    if (!PIN_RE.test(host)) throw new Error("Not a Pinterest page");
    const html = await page.text();
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    if (!m) throw new Error("No image found");
    const img = m[1].replace(/&amp;/g, "&");
    if (!new URL(img).hostname.endsWith("pinimg.com")) throw new Error("Unexpected image host");
    for (const c of [img.replace(/\/(\d+x|originals)\//, "/originals/"), img]) {
        const r = await fetch(c, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 25 * 1024 * 1024) throw new Error("Image too large");
        const ext = /png/i.test(r.headers.get("content-type") || "") ? "png" : "jpg";
        const file = path.join(DOWNLOAD_DIR, `${prefix}.${ext}`);
        fs.writeFileSync(file, buf);
        return file;
    }
    throw new Error("Image download failed");
}

app.get("/api/dl", async (req, res) => {
    if (!acquireDownloadSlot(res)) return;

    const prefix = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    try {
        const url = String(req.query.url || "").trim();
        const type = String(req.query.type || "auto").toLowerCase();

        if (!url || url.length > 500 || !isValidUrl(url)) {
            return res.status(400).json({ success: false, error: "Invalid URL" });
        }
        if (!siteAllowed(url)) {
            return res.status(400).json({ success: false, error: "This site is not supported" });
        }

        console.log(`⬇️ DL (${type}):`, url);

        const opts = {
            noWarnings: true,
            noPlaylist: true,
            maxFilesize: "95M",
            output: path.join(DOWNLOAD_DIR, `${prefix}.%(ext)s`)
        };
        if (process.env.SITE_COOKIES && fs.existsSync(process.env.SITE_COOKIES)) {
            opts.cookies = process.env.SITE_COOKIES;
        }
        if (type === "audio") {
            Object.assign(opts, { extractAudio: true, audioFormat: "mp3", audioQuality: "0" });
        } else {
            Object.assign(opts, { format: "bv*[height<=720]+ba/b[height<=720]/b", mergeOutputFormat: "mp4" });
        }

        const isPin = /pinterest|pin\.it/i.test(url);
        try {
            await youtubedl(url, opts);
        } catch (e) {
            if (!isPin) throw e;
        }

        const found = fs.readdirSync(DOWNLOAD_DIR)
            .filter(f => f.startsWith(prefix + ".") && !/\.(part|ytdl|tmp)$/i.test(f))
            .map(f => path.join(DOWNLOAD_DIR, f))
            .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);

        let file = found[0];
        if (!file && isPin) file = await pinterestImage(url, prefix);
        if (!file) throw new Error("Nothing was downloaded");

        const ext = path.extname(file).slice(1).toLowerCase();
        console.log("✔ DL READY:", file);
        sendFileAndCleanup(res, file, `vortex-media.${ext}`, MIME[ext] || "application/octet-stream", prefix);

    } catch (error) {
        console.error("DL ERROR:", String(error.message).split("\n")[0].slice(0, 200));
        cleanupPrefix(prefix);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: "Download failed. The post may be private, removed, or the site changed." });
        }
    } finally {
        releaseDownloadSlot();
    }
});

app.use(
    (req, res) => {
        res.status(404).json({
            success: false,
            error:
                "Endpoint not found"
        });
    }
);

/* =========================
   ERROR HANDLER
========================= */

app.use(
    (
        error,
        req,
        res,
        next
    ) => {
        console.error(
            "SERVER ERROR:",
            error.message
        );

        if (
            res.headersSent
        ) {
            return next(error);
        }

        res.status(500).json({
            success: false,
            error:
                "Internal server error"
        });
    }
);

/* =========================
   START
========================= */

app.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log("");

        console.log(
            "╔══════════════════════════════════════╗"
        );

        console.log(
            "║       VORTEX MEDIA API v5.0.0       ║"
        );

        console.log(
            "╚══════════════════════════════════════╝"
        );

        console.log("");

        console.log(
            `🚀 Server: http://0.0.0.0:${PORT}`
        );

        console.log(
            `📁 Downloads: ${DOWNLOAD_DIR}`
        );

        console.log(
            `⚡ Max downloads: ${MAX_CONCURRENT}`
        );

        console.log(
            `🔐 API key: ${
                API_KEY
                    ? "enabled"
                    : "disabled"
            }`
        );

        console.log(
            "🟢 JS runtime: Node"
        );

        console.log(
            "🟢 EJS component: enabled"
        );

        console.log(
            `🍪 Cookies: ${
                YOUTUBE_COOKIES
                    ? "configured"
                    : "not configured"
            }`
        );

        console.log("");

        console.log(
            "✔ Search ready"
        );

        console.log(
            "✔ Music ready"
        );

        console.log(
            "✔ Video ready"
        );

        console.log(
            "✔ FFmpeg ready"
        );

        console.log(
            "✔ Node/yt-dlp ready"
        );

        console.log("");
    }
);
